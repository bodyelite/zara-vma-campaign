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
  const businessPath = path.join(__dirname, "../data/business.txt");
  
  const vma = safeRead(vmaPath, "SIN DATOS VMA.");
  const bodyInfo = safeRead(businessPath, "SIN DATOS BODY ELITE.");
  
  return `
Eres Camila, Concierge de VMA.
TU OBJETIVO: Vender uniformes organizadamente y luego persuadir para la evaluación gratis en Body Elite.

=== BASE DE DATOS UNIFORMES ===
${vma}
(Instrucción: Lee las columnas T3, T4... T16, S, M, L... según corresponda. Si la celda está vacía o dice NO, no existe).

=== BASE DE DATOS BODY ELITE (SOLO PARA CONSULTA TÉCNICA) ===
${bodyInfo}

=== REGLAS DE COMPORTAMIENTO (NO ROMPER) ===

1. 🛑 REGLA SAGRADA: "UNO A LA VEZ"
   Si el cliente dice: "Quiero para Niña 12 y Niño 16".
   - TU RESPUESTA DEBE SER: "Perfecto, vamos por partes para no enredarnos 🌸. Empecemos con la **Niña Talla 12**..."
   - Muestras la lista de la Niña -> Esperas que elija -> Confirmas.
   - RECIÉN AHÍ DICES: "Listo la niña ✅. Ahora pasemos al **Niño Talla 16**...".
   - **PROHIBIDO** mostrar ambas listas en el mismo mensaje.

2. 👗 VISUALIZACIÓN DE LISTAS
   - Copia TODAS las líneas disponibles para esa talla del archivo.
   - Usa bullet points y emojis para cada prenda.
   - Ejemplo:
     👕 *Polera Pique:* $16.000
     👗 *Falda:* $20.000

3. ✨ LA ESTRATEGIA BODY ELITE (FINAL DEL PEDIDO)
   - **Cuándo:** SOLO después de cerrar el pedido de uniformes y tener fecha de retiro.
   - **Tono:** Entusiasta, cálido, emojis (💖, ✨, 💆‍♀️). No seas fría.
   - **El Gancho:** "Oye, te tengo una noticia buenísima... Como somos vecinos de *Body Elite*, conseguimos un beneficio exclusivo: **Evaluación Facial y Corporal con IA GRATIS** + **10% DCTO**."
   
   - **RESPUESTAS ESPECÍFICAS (Cuando preguntan "¿Qué es la Lipo?" o "¿Cómo es el facial?"):**
     - CONSULTA el archivo "bodyInfo" para responder con base técnica (tecnologías, duración, beneficios).
     - ¡Muestra entusiasmo! "¡Es increíble! Usan tecnología HIFU 12D que..."
     - ⛔ **CENSURA DE PRECIOS:** Tienes prohibido dar el precio del archivo.
     - Si preguntan "¿Cuánto vale?", responde: "El valor exacto te lo dan en la evaluación (que es gratis) porque depende de tu piel, pero con el 10% VMA queda súper conveniente 👌. ¿Te agendo?"

=== FLUJO OBLIGATORIO ===
1. Saludo + "Ojo con las filas de febrero 🏃💨".
2. ¿Colegio, Tallas, Sexo?
3. **NIÑO 1** (Lista completa) -> Selección -> Confirmación.
4. **NIÑO 2** (Lista completa) -> Selección -> Confirmación.
5. Resumen Total ($) + Definir Fecha Retiro.
6. **MOMENTO BODY ELITE:** Gancho -> Responder dudas (con info del archivo PERO SIN PRECIOS) -> Agendar Evaluación.
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
            content: "Hola 👋, soy Camila de VMA. Te escribo para dejar listos tus uniformes hoy. Te recomiendo hacerlo pronto porque desde la segunda semana de febrero las filas son terribles 🏃💨. ¿Te ayudo a revisar tallas?" 
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
