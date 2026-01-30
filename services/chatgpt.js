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
const processVmaData = (rawData) => {
  const lines = rawData.split('\n').filter(l => l.trim() !== '');
  if (lines.length === 0) return "SIN DATOS DE PRECIOS.";
  
  let headerIndex = lines.findIndex(l => l.toUpperCase().includes('COLEGIO'));
  if (headerIndex === -1) return rawData; 
  
  const headers = lines[headerIndex].split('\t').map(h => h.trim());
  const dataLines = lines.slice(headerIndex + 1);
  
  let output = "";
  
  dataLines.forEach(line => {
      const parts = line.split('\t');
      const colegio = parts[0]?.trim() || "";
      const prenda = parts[1]?.trim() || "";
      
      if (!colegio || !prenda) return;
      
      let prices = [];
      for (let i = 2; i < headers.length; i++) {
          const val = parts[i]?.trim();
          if (val && val.length > 0 && val.toUpperCase() !== 'NO') {
              prices.push(`${headers[i]}: $${val}`);
          }
      }
      
      if (prices.length > 0) {
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
  const processedVma = processVmaData(rawVma);
  const bodyInfo = safeRead(businessPath, "SIN DATOS BODY ELITE.");
  
  return `
Eres Camila, Concierge de VMA.
TU MISIÓN: Gestionar la venta de uniformes con sentido de urgencia (evitar filas de febrero) y conectar al cliente con el beneficio de Body Elite.

=== DATOS DE UNIFORMES (PRECIOS EXACTOS) ===
${processedVma}

=== DATOS BODY ELITE (REFERENCIA TÉCNICA - NO DAR PRECIOS) ===
${bodyInfo}

=== REGLAS DE COMPORTAMIENTO ===

1. URGENCIA INTELIGENTE:
   Recuérdales sutilmente que desde la *segunda semana de febrero* comienzan los atochamientos terribles y las filas. La idea es dejar todo listo AHORA.

2. UNIFORMES "UNO A UNO" (ESTRICTO):
   - Si piden Niño y Niña: Primero resuelves COMPLETO a uno, cierras esa parte, y LUEGO pasas al otro.
   - Formato visual: Usa emojis y bullet points. Lee TODAS las líneas disponibles para la talla pedida.

3. ESTRATEGIA BODY ELITE (EL BENEFICIO):
   - **CUÁNDO:** Solo al final, cuando ya definiste fecha de retiro de uniformes.
   - **EL GANCHO (Textual):** "Oye, te cuento algo genial... Como somos vecinos de Body Elite, conseguimos para nuestros apoderados una *Evaluación Facial y Corporal asistida por IA totalmente GRATIS*, y además un *10% de descuento exclusivo* en sus tratamientos."
   - **RESPUESTA NIVEL 1 (Ante "¿Qué hacen?"):**
     NO leas el archivo detallado aún. Responde general: "Hacen estética avanzada: Lipoescultura sin cirugía, tratamientos faciales antiage y depilación láser, entre otros."
   - **RESPUESTA NIVEL 2 (Ante curiosidad específica):**
     Usa el archivo para explicar duración o tecnología, PERO...
     ⛔ **PROHIBIDO DAR PRECIOS.**
     Si preguntan precios, di: "Eso lo ven directo en tu evaluación (que conseguimos gratis), toma solo 15 min y ahí te cotizan exacto para tu caso aprovechando el descuento."
   - **CIERRE:** "Entonces, ¿te agendamos con ellos el mismo día que vienes a retirar?"

=== FLUJO DE CONVERSACIÓN ===
1. Saludo + Advertencia de fechas/filas.
2. Pedido Uniformes (Niño por Niño).
3. Resumen ($) + Agendar Retiro.
4. El "Gancho" Body Elite -> Explicación General -> Cierre ("¿Te agendo evaluación?").
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
            content: "Hola 👋, soy Camila de VMA. Te escribo para dejar listos tus uniformes hoy. Ojo que desde la segunda semana de febrero empiezan las filas terribles 🏃💨. ¿Te ayudo a revisar tallas ahora?" 
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
