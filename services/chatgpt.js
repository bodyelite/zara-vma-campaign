const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const conversationHistory = {};

// ---------- Helpers ----------
const safeRead = (filePath, fallback = "") => {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch (e) {
    console.error("safeRead error:", filePath, e.message);
    return fallback;
  }
};

// ---------- PARSER INTELIGENTE DE PRECIOS ----------
// Esta función convierte la tabla confusa en una lista a prueba de balas.
const processVmaData = (rawData) => {
  const lines = rawData.split('\n').filter(l => l.trim() !== '');
  if (lines.length === 0) return "SIN DATOS DE PRECIOS.";
  
  // Buscar la cabecera (fila que dice COLEGIO, PRENDA...)
  let headerIndex = lines.findIndex(l => l.toUpperCase().includes('COLEGIO'));
  if (headerIndex === -1) return rawData; // Si falla, devuelve crudo
  
  const headers = lines[headerIndex].split('\t').map(h => h.trim());
  const dataLines = lines.slice(headerIndex + 1);
  
  let output = "";
  
  dataLines.forEach(line => {
      const parts = line.split('\t');
      const colegio = parts[0]?.trim() || "";
      const prenda = parts[1]?.trim() || "";
      
      if (!colegio || !prenda) return;
      
      let prices = [];
      // Empezamos desde la columna 2 (T3, T4...) hasta el final
      for (let i = 2; i < headers.length; i++) {
          const val = parts[i]?.trim();
          if (val && val.length > 0 && val.toUpperCase() !== 'NO') {
              prices.push(`${headers[i]}: $${val}`);
          }
      }
      
      if (prices.length > 0) {
          // Formato: MAYOR - FALDA ➤ [ T3: $11000 | T6: $12000 ]
          output += `🔴 ${colegio} - ${prenda} ➤ [ ${prices.join(' | ')} ]\n`;
      }
  });
  return output;
};

// Cache Context
let cachedContext = null;
let cachedAt = 0;
const CONTEXT_TTL_MS = 2 * 60 * 1000;

const buildContext = () => {
  const vmaPath = path.join(__dirname, "../data/vma_precios.txt");
  const businessPath = path.join(__dirname, "../data/business.txt");
  
  const rawVma = safeRead(vmaPath, "");
  const processedVma = processVmaData(rawVma); // <--- AQUI LA MAGIA
  const bodyInfo = safeRead(businessPath, "SIN DATOS BODY ELITE.");
  
  return `
Eres Camila, Concierge de VMA.
TU PERSONALIDAD: Ordenada, usas emojis 🌸, eres visual (listas bonitas) y persuasiva con los beneficios.

=== BASE DE DATOS PROCESADA (USAR ESTOS PRECIOS EXACTOS) ===
${processedVma}

=== DATOS DE BODY ELITE (ESTÉTICA AVANZADA) ===
${bodyInfo}

=== REGLA DE ORO: EL "UNO A UNO" ===
Si el cliente pide "Niña 12 y Niño 16":
1.  **PROHIBIDO** mostrar las dos listas juntas.
2.  Muestras la lista de la Niña -> Esperas que el cliente elija -> Confirmas.
3.  RECIÉN AHÍ pasas al Niño -> Muestras lista -> Esperas -> Confirmas.
4.  Finalmente haces el Resumen Total.

=== CÓMO MOSTRAR LOS PRECIOS (CRÍTICO) ===
1.  Busca la línea que coincida con el COLEGIO y la PRENDA.
2.  Busca dentro de los corchetes [ ] la TALLA pedida (Ej: T12).
3.  **SI LA TALLA EXACTA NO ESTÁ:** Usa el precio de la talla más cercana disponible (Ej: Si pide T12 y solo hay T10 y T14, usa el precio de T14 para asegurar).
4.  **FORMATO VISUAL:** Transforma la lista en bullet points bonitos con emojis. NO pongas el texto crudo.
    Ejemplo:
    👕 *Polera Pique:* $16.000
    👗 *Falda:* $22.000

=== ESTRATEGIA BODY ELITE (PERSUASIÓN EMOCIONAL) ===
El dato de Body Elite se da **SOLO AL FINAL**, tras agendar los uniformes.
- **Actitud:** "Dato de vecino", "Secreto compartido".
- **Script:** "Oye, te cuento algo buenísimo... Como somos vecinos de la Clínica Body Elite (Estética Avanzada), conseguimos un beneficio exclusivo para los apoderados del VMA. 💆‍♀️"
- **Oferta:** Evaluación GRATIS + 10% DCTO en todo.
- **Precios:** NO LOS DES DE ENTRADA. Vende la evaluación. Si insisten, di que son "precios de mercado muy convenientes" y dales un rango solo si es necesario.

=== FLUJO DE CONVERSACIÓN ===
1.  Saludo + Filtro (Colegio/Tallas/Sexo).
2.  Niño 1 (Lista Completa Procesada).
3.  Niño 2 (Lista Completa Procesada).
4.  Resumen Total ($) + Agendar Retiro.
5.  GANCHO Body Elite + Agendar Evaluación.
`;
};

const getContext = () => {
  const now = Date.now();
  if (!cachedContext || now - cachedAt > CONTEXT_TTL_MS) {
    cachedContext = buildContext();
    cachedAt = now;
  }
  return cachedContext;
};

const chatWithGPT = async (message, remoteJid) => {
  try {
    if (!remoteJid) remoteJid = "unknown";

    if (!conversationHistory[remoteJid]) {
      conversationHistory[remoteJid] = [
        { role: "system", content: getContext() },
        { 
            role: "assistant", 
            content: "Hola 👋, soy Camila de VMA. Te escribo para ayudarte con los uniformes y así te ahorras las filas horribles de marzo 🏃💨. ¿Te ayudo a revisar tallas y precios por acá?" 
        }
      ];
    }

    conversationHistory[remoteJid].push({ role: "user", content: String(message || "") });

    const MAX_MESSAGES = 22; 
    const KEEP_TAIL = 16; 
    if (conversationHistory[remoteJid].length > MAX_MESSAGES) {
      conversationHistory[remoteJid] = [
        conversationHistory[remoteJid][0], 
        conversationHistory[remoteJid][1], 
        ...conversationHistory[remoteJid].slice(-KEEP_TAIL),
      ];
    }

    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      messages: conversationHistory[remoteJid],
      temperature: 0.2, 
      max_tokens: 850, 
    });

    const reply = (response.choices?.[0]?.message?.content || "").trim();
    const safeReply = reply || "¿Me confirmas el colegio?";

    conversationHistory[remoteJid].push({ role: "assistant", content: safeReply });

    return safeReply;
  } catch (e) {
    console.error("Error OpenAI:", e);
    return "Dame un segundo, estoy revisando el stock...";
  }
};

module.exports = { chatWithGPT };
