const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Historial de conversación en memoria
const conversationHistory = {};

// Función segura para leer archivos (evita que se caiga si falta uno)
const safeRead = (filePath) => {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch (e) {
    console.error("Error leyendo archivo:", filePath);
    return ""; // Retorna vacío si falla, no rompe el bot
  }
};

// Carga de contexto unificada
const getContext = () => {
  // 1. Cargar Precios VMA
  const vmaPath = path.join(__dirname, "../data/vma_precios.txt");
  const vmaData = safeRead(vmaPath);

  // 2. Cargar Info Body Elite
  const businessPath = path.join(__dirname, "../data/business.txt");
  const businessData = safeRead(businessPath);
  
  return `
  Eres Camila (Zara), Concierge de VMA Uniformes y Body Elite.
  
  === TUS FUENTES DE VERDAD (NO INVENTES NADA FUERA DE ESTO) ===
  
  [TABLA DE PRECIOS Y STOCK VMA]
  (Interpretación: Las columnas son tallas. Si una celda dice "NO", "-", o está vacía, NO HAY STOCK).
  ${vmaData}

  [DATOS BODY ELITE]
  ${businessData}

  === REGLAS DE LÓGICA (STRICT MODE) ===
  
  1. **DETECCIÓN DE CANTIDAD (CRÍTICO):**
     - Si el cliente habla en SINGULAR (ej: "mi hija", "el niño", "necesito talla 14"), ASUME QUE ES SOLO UNO. Vende directo. NO preguntes "¿hay alguien más?" ni "¿cómo se llama?".
     - SOLO si el cliente dice explícitamente PLURAL (ej: "mis hijos", "tengo dos", "la mayor y el chico"), aplicas la regla de "vamos uno por uno".

  2. **LECTURA DE STOCK:**
     - Mira la tabla VMA. Si piden una talla y en la tabla sale precio, DI EL PRECIO.
     - Si en la tabla sale "NO" o vacío, di: "Esa talla está agotada/crítica por ahora".
     - Identifica el colegio del cliente. Si no lo dice, pregúntalo.

  3. **ESTRATEGIA DE VENTA:**
     - Objetivo 1: Cerrar el uniforme VMA (urgencia: evitar filas de marzo).
     - Objetivo 2: SOLO al confirmar el uniforme o cerrar la venta, ofrece el beneficio de Body Elite (Evaluación IA Gratis o descuentos) como un "regalo" o "plus".

  4. **PERSONALIDAD:**
     - Eres ejecutiva, eficiente y usas formato WhatsApp (breve).
     - No saludes de nuevo si ya hay conversación.
  `;
};

async function chatWithGPT(text, jid) {
    // Inicializar historial si es nuevo
    if (!conversationHistory[jid]) {
      conversationHistory[jid] = [
        { role: "system", content: getContext() },
        // Mensaje inicial "fantasma" para dar contexto de que ya saludamos
        { role: "assistant", content: "Hola, soy Camila de VMA. ¿Te ayudo con los uniformes?" } 
      ];
    }

    // Agregar mensaje del usuario
    conversationHistory[jid].push({ role: "user", content: String(text || "") });

    // Mantener memoria corta (últimos 16 mensajes para no gastar tokens ni confundirse)
    if (conversationHistory[jid].length > 18) {
      conversationHistory[jid] = [
        conversationHistory[jid][0], // Mantener System Prompt
        ...conversationHistory[jid].slice(-16) // Mantener últimos mensajes
      ];
    }

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini", // Rápido y eficiente
            messages: conversationHistory[jid],
            temperature: 0.2, // Baja temperatura = NO alucinaciones, se pega al archivo
            max_tokens: 400,
        });

        const reply = response.choices[0].message.content;
        
        // Guardar respuesta en historial
        conversationHistory[jid].push({ role: "assistant", content: reply });
        
        return reply;

    } catch (error) {
        console.error("Error OpenAI:", error);
        return "Dame un segundo, estoy revisando el stock en bodega..."; // Fallback elegante
    }
}

module.exports = { chatWithGPT };
