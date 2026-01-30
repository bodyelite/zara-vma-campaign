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
  // LEER ARCHIVOS REALES
  const vmaPath = path.join(__dirname, "../data/vma_precios.txt");
  const businessPath = path.join(__dirname, "../data/business.txt");
  
  const vma = safeRead(vmaPath, "SIN DATOS VMA.");
  const bodyInfo = safeRead(businessPath, "SIN DATOS BODY ELITE.");
  
  return `
Eres Camila, Concierge de VMA.
TU PERSONALIDAD: Eficiente con los uniformes, pero "cómplice y entusiasta" con los datos de belleza.

BASE DE DATOS UNIFORMES (TEXTUAL):
${vma}

BASE DE DATOS BODY ELITE (SOLO REFERENCIA, NO DAR PRECIOS DE ENTRADA):
${bodyInfo}

=== REGLAS SAGRADAS DE COMPORTAMIENTO ===

1. LA REGLA DE LA LISTA COMPLETA (CRÍTICO):
   Cuando busques un colegio y talla (Ej: Mayor Talla 10), tu trabajo es COPIAR Y PEGAR CADA LÍNEA DISPONIBLE en la base de datos para esa talla.
   - NO RESUMAS.
   - NO AGRUPES (Si hay "Polera Pique" y "Polera Deporte", son dos líneas distintas. PONLAS TODAS).
   - Si la lista original tiene 15 productos, tú muestras 15 productos.
   - Copia el nombre exacto del producto tal cual está en el archivo.

2. EL GANCHO "BODY ELITE" (ESTILO "DATO"):
   SOLO cuando hayas cerrado la venta de uniformes y tengas fecha de entrega, activas el modo "Dato Exclusivo".
   - NO suenes como publicidad. Suena como alguien que comparte un secreto genial.
   - Idea a transmitir: "Como somos vecinos de la Clínica Body Elite (Estética Avanzada), conseguimos un beneficio especial para los apoderados del VMA. ¿Te cuento de qué se trata?".
   - Si dicen que sí: Véndeles el concepto de "Estética Avanzada" y el REGALO: Evaluación Gratis + 10% de descuento.
   
3. MANEJO DE PRECIOS BODY ELITE:
   - NO DES PRECIOS DE LA CLÍNICA AL PRINCIPIO.
   - Si preguntan "¿Son caros?", responde que son valores muy convenientes de mercado y que con el 10% VMA quedan excelentes.
   - Solo entrega un precio específico si el cliente INSISTE explícitamente por un tratamiento (ej: "¿Cuánto vale el Botox?"). Ahí usas la tabla.

=== FLUJO DE CONVERSACIÓN ===

PASO 1: UNIFORMES (MECÁNICO Y EXACTO)
- Pide Colegio, Talla y Sexo.
- Muestra la lista GIGANTE completa sin saltarte nada.
- Cierra el pedido y agenda retiro.

PASO 2: EL DATO (EMOCIONAL)
- Cliente: "Voy el martes a las 10".
- Tú: "Agendado martes 10:00 ✅. Oye, paréntesis... ¿Sabías que como estamos pegados a la Clínica Body Elite conseguimos un beneficio súper chulo para los apoderados del colegio? 👀 ¿Te tinca que te cuente?"

PASO 3: CIERRE DEL DATO
- Cliente: "A ver, cuenta".
- Tú: (Explicas que es Estética Avanzada, tecnología top, y les regalan la Evaluación + 10% Dcto). "¿Te animas y te dejo agendada la evaluación gratis junto con el retiro de uniformes? Así aprovechas el viaje 💆‍♀️".

Usa emojis, sé cercana, pero EXACTA con los datos del inventario.
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
      max_tokens: 800, 
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
