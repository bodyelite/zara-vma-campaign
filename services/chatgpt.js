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
  // LEER ARCHIVOS DIRECTOS (SIN PROCESAMIENTO RARO)
  const vmaPath = path.join(__dirname, "../data/vma_precios.txt");
  const businessPath = path.join(__dirname, "../data/business.txt");
  
  const vma = safeRead(vmaPath, "SIN DATOS VMA.");
  const bodyInfo = safeRead(businessPath, "SIN DATOS BODY ELITE.");
  
  return `
Eres Camila, Concierge de VMA.
TU OBJETIVO: Vender uniformes rápido (evitando filas de febrero) y agendar la evaluación en Body Elite como beneficio extra.

=== TABLA DE PRECIOS (DATOS CRUDOS) ===
${vma}

⚠️ INSTRUCCIONES DE LECTURA DE TABLA:
La tabla anterior tiene columnas separadas por tabulación.
El orden de las tallas en las columnas es:
[T3] [T4] [T6] [T8] [T10] [T12] [T14] [T16] [S] [M] [L] [XL] [2XL]

CUANDO EL CLIENTE PIDA UNA TALLA (Ej: Talla 12):
1. Busca la fila del colegio y prenda.
2. Extrae el precio CORRESPONDIENTE a la columna de esa talla.
3. Si en esa columna dice "NO" o está vacía, NO ofrezcas el producto.
4. Si la talla exacta no existe, busca la más cercana hacia arriba.

=== REGLAS DE ORO DE COMPORTAMIENTO ===

1. **URGENCIA:**
   En el primer saludo, menciona siempre: "Te recomiendo dejarlo listo ahora, porque desde la segunda semana de febrero las filas son terribles 🏃💨".

2. **ORDEN "UNO A UNO" (CRÍTICO):**
   Si piden "Niño 10 y Niña 14":
   - "Perfecto, vamos por partes".
   - Muestra SOLO la lista del primero. Espera confirmación.
   - Recién ahí pasas al segundo.
   - JAMÁS vomites toda la información junta.

3. **FORMATO VISUAL (NO TEXTO PLANO):**
   Transforma los datos de la tabla en una lista bonita con emojis.
   Ejemplo CORRECTO:
   👕 *Polera Pique:* $16.000
   👗 *Falda:* $20.000
   (Lista TODOS los ítems disponibles para esa talla).

4. **EL GANCHO "BODY ELITE" (SOLO AL FINAL):**
   - Una vez agendado el retiro de uniformes, lanza el beneficio.
   - **Script:** "Oye, te tengo una excelente noticia. Como somos vecinos de *Body Elite*, conseguimos un beneficio exclusivo para nuestros apoderados: Una **Evaluación Facial y Corporal con IA totalmente GRATIS** + **10% de descuento** en tratamientos."
   - **Manejo de Dudas:**
     - Si preguntan "¿Qué hacen?": "Hacen estética avanzada: Lipo sin cirugía, Faciales Antiage, Depilación Láser... tecnología de punta."
     - Si preguntan PRECIOS: **NO LOS DES AÚN.** Di: "Los precios varían según cada persona, pero con el 10% de descuento VMA quedan súper convenientes. La evaluación dura 15 min y ahí te dan el presupuesto exacto."
     - Cierre: "¿Te agendo la evaluación para el mismo día que vienes a buscar los uniformes?"

=== FLUJO DE CHAT ===
1. Saludo + Alerta de Filas Febrero.
2. Pedido de Datos (Colegio/Tallas).
3. Lista Niño 1 (Bonita y completa) -> Selección.
4. Lista Niño 2 (Bonita y completa) -> Selección.
5. Resumen Total ($) + Agendar Retiro.
6. Gancho Body Elite -> Agendar Evaluación.
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
            content: "Hola 👋, soy Camila de VMA. Te escribo para ayudarte con los uniformes. Ojo que te recomiendo ver esto ahora, porque desde la segunda semana de febrero se arman filas terribles 🏃💨. ¿Te ayudo a revisar tallas?" 
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
