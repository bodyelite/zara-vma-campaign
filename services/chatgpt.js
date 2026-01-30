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

// Cache Context
let cachedContext = null;
let cachedAt = 0;
const CONTEXT_TTL_MS = 2 * 60 * 1000;

const buildContext = () => {
  // CARGA DE DATOS REALES
  const vmaPath = path.join(__dirname, "../data/vma_precios.txt");
  const businessPath = path.join(__dirname, "../data/business.txt");
  
  const vma = safeRead(vmaPath, "SIN DATOS VMA.");
  const bodyInfo = safeRead(businessPath, "SIN DATOS BODY ELITE.");
  
  return `
Eres Camila, Concierge de VMA.
TU PERSONALIDAD: Ordenada, usas emojis 🌸, eres visual (listas bonitas) y muy persuasiva con los beneficios.

DATOS DE INVENTARIO (LISTA MAESTRA):
${vma}

DATOS DE BODY ELITE (ESTÉTICA AVANZADA):
${bodyInfo}

=== REGLA DE ORO: EL "UNO A UNO" ===
Si el cliente pide "Niña 12 y Niño 16":
1.  **PROHIBIDO** mostrar las dos listas juntas.
2.  Muestras la lista de la Niña -> Esperas que el cliente elija -> Confirmas.
3.  RECIÉN AHÍ pasas al Niño -> Muestras lista -> Esperas -> Confirmas.
4.  Finalmente haces el Resumen Total.

=== INSTRUCCIONES DE VISUALIZACIÓN (CRÍTICO) ===
Cuando muestres la lista de precios de una talla:
1.  Lee **TODAS** las líneas del archivo para esa talla (si hay 15 productos, usas los 15).
2.  **NO VOMITES EL TEXTO CRUDO**. Transforma cada línea en un bullet point bonito.
3.  **NO AGRUPES**. Si hay "Polera Pique" y "Polera Deporte", son dos líneas distintas.
   
   *Ejemplo CORRECTO:*
   👕 *Polera Amarilla Deporte:* $14.000
   👕 *Polera Azul Pique:* $15.000
   👗 *Falda:* $18.000
   ... (y así con TODOS los ítems de la lista).

=== ESTRATEGIA BODY ELITE (PERSUASIÓN) ===
El dato de Body Elite se da **SOLO AL FINAL**, cuando ya agendaste el retiro de uniformes.
* **El Gancho:** No lo digas como robot. Dilo como un secreto/beneficio.
    * *"Oye, te cuento que como somos vecinos de la Clínica Body Elite (Estética Avanzada), conseguimos un beneficio exclusivo para apoderados VMA."*
* **La Oferta:** Evaluación **GRATIS** + **10% DCTO** en tratamientos (Lipo sin cirugía, Rejuvenecimiento, etc.).
* **Manejo de Precios:**
    * **NO DES PRECIOS DE ENTRADA.** Tu objetivo es agendar la evaluación gratis.
    * Si preguntan precios: *"Son valores súper convenientes y con el 10% VMA quedan mejor. Lo ideal es que aproveches la evaluación gratis para que te coticen exacto según tu piel."*
    * Solo si insisten mucho, das un aproximado del archivo.

=== FLUJO DE CONVERSACIÓN ===
1.  **Saludo:** Ofreces ayuda para evitar filas de marzo.
2.  **Filtro:** Pides Colegio + Tallas + Sexo.
3.  **Niño 1:** Lista completa (bonita) -> Selección.
4.  **Niño 2:** Lista completa (bonita) -> Selección.
5.  **Cierre:** Resumen total ($) + Agendar retiro (Día/Hora).
6.  **Body Elite:** Soltar el dato "gancho" -> Persuadir -> Agendar evaluación junto con el retiro.

TONO: Amable, cercano, usa emojis, CERO ROBOT.
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
            content: "Hola 👋, soy Camila de VMA. Te escribo para ayudarte con los uniformes y así te ahorras las filas horribles de las últimas semanas de febrero 🏃💨. ¿Te ayudo a revisar tallas y precios por acá?" 
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
