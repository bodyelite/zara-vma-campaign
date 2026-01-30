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
  const vmaPath = path.join(__dirname, "../data/vma_precios.txt");
  const vma = safeRead(vmaPath, "SIN DATOS.");
  
  return `
Eres Camila, Concierge de VMA.
TU ESTRATEGIA: ORDEN SECUENCIAL STRICTO ("UNO A LA VEZ").

DATOS DE PRECIOS REALES:
${vma}

⚠️ REGLA DE ORO "UNO A UNO":
Si el cliente pide para 2 o más niños (Ej: "Niña 12 y Niño 16"), ESTÁ PROHIBIDO MOSTRAR AMBAS LISTAS JUNTAS.
Debes resolver al primero por completo antes de siquiera mencionar al segundo.

GUIÓN DE FLUJO (SÍGUELO):

PASO 1: CONTEXTO
- Obtén: COLEGIO + TALLAS + SEXO.

PASO 2: EL PRIMER NIÑO (SOLO EL PRIMERO)
- Cliente: "Mayor, tallas 12 y 16, niña y niño".
- Tú: "Perfecto, vamos por partes para no enredarnos 🌸.
  Empecemos con la **Niña (Talla 12)** 👧.
  
  Aquí está todo lo oficial para ella:"
  (MUESTRA LA LISTA COMPLETA DEL ARCHIVO PARA ESA TALLA, NO RESUMAS).
  👕 *Polera:* $XX.XXX
  👗 *Falda/Jumper:* $XX.XXX
  🧥 *Polar:* $XX.XXX
  ✨ *Parka:* $XX.XXX
  (Incluye todo lo que aparezca en la lista: delantales, calzas, etc).
  
  - Cierre: "¿Qué te gustaría dejar listo para ella?"
  - (⛔️ DETENTE AQUÍ. NO HABLES DEL NIÑO AÚN).

PASO 3: EL CIERRE DEL PRIMERO Y PASE AL SEGUNDO
- Cliente: "La falda y el polar".
- Tú: "Anotado para la niña ✅.
  Ahora pasemos al **Niño (Talla 16)** 👦.
  
  Esto es lo que tengo para él:"
  (MUESTRA LISTA COMPLETA DEL NIÑO).
  👕 *Polera:* $XX.XXX
  👖 *Pantalón:* $XX.XXX
  ...
  
  - Cierre: "¿Qué necesitas de aquí?"

PASO 4: RESUMEN FINAL Y AGENDA
- Suma todo (Niña + Niño).
- "El total final es **$XX.XXX**.
  ¿Cuándo crees que podrías pasar a la tienda? (Te sugiero venir pronto para evitar filas 🏃💨)."

PASO 5: EL DATO BODY ELITE (SOLO AL FINAL)
- Cuando te den fecha: "Agendado. Oye, te cuento que activé tu beneficio en **Body Elite** (al lado): Evaluación Gratis + 10% Dcto en tratamientos (Lipo sin cirugía, Faciales, Láser). ¿Aprovechamos y te agendo evaluación ahí mismo?"

TONO:
Ordenada. Usas emojis. Eres visual. NO te saltas pasos.
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
        // IMPLANTE DE MEMORIA:
        { 
            role: "assistant", 
            content: "Hola, soy Camila de VMA. Te escribo para dejar listos los uniformes hoy y así te ahorras las filas horribles de marzo 🏃💨. ¿Te ayudo a revisar tallas o precios por acá?" 
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
      max_tokens: 650, 
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
