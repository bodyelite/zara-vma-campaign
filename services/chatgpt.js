const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
let conversationHistory = {};

// LEER ARCHIVOS (Ojos del Bot)
const leerArchivo = (nombre) => {
    try {
        const ruta = path.join(__dirname, '../data', nombre);
        if (fs.existsSync(ruta)) return fs.readFileSync(ruta, 'utf-8');
    } catch (e) { return ""; }
    return "";
};

const chatWithGPT = async (message, remoteJid) => {
    try {
        if (!remoteJid) remoteJid = "test_user";

        // 1. CARGAR DATOS FRESCOS
        const promptBase = leerArchivo('system_prompt.txt');
        const precios = leerArchivo('vma_precios.txt');
        const bodyInfo = leerArchivo('business.txt');

        // 2. INYECTARLOS EN EL CONTEXTO
        const systemMessage = `
${promptBase}

=== 📊 LISTA DE PRECIOS OFICIAL VMA ===
${precios}

=== 🏥 INFO TÉCNICA BODY ELITE ===
${bodyInfo}
        `;

        // 3. INICIALIZAR MEMORIA (PRIMING)
        if (!conversationHistory[remoteJid]) {
            conversationHistory[remoteJid] = [
                { role: "system", content: systemMessage },
                { role: "assistant", content: "Hola, soy Camila de VMA. Te escribo para ayudarte con el stock escolar 2026. ¿En qué te ayudo?" }
            ];
        }

        conversationHistory[remoteJid].push({ role: "user", content: String(message || "") });

        // 4. GENERAR RESPUESTA (CAPACIDAD AUMENTADA)
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: conversationHistory[remoteJid],
            max_tokens: 1200, // <--- ✅ AHORA SÍ: 1200 TOKENS
            temperature: 0.4, 
        });

        const response = completion.choices[0].message.content;
        conversationHistory[remoteJid].push({ role: "assistant", content: response });
        return response;

    } catch (error) {
        console.error("Error GPT:", error);
        return "Dame un segundo... 🧠";
    }
};

module.exports = { chatWithGPT };
