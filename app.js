const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require("@whiskeysockets/baileys");
const pino = require("pino");
const express = require("express");
const fs = require("fs");
const path = require("path");
const { chatWithGPT } = require("./services/chatgpt");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const CHAT_HISTORY_FILE = "/data/historial_chats.json";
const AUTH_DIR = "/data/auth_info_baileys";

let botActivo = false; 
let webStatus = "⏸️ MODO OBSERVADOR";

// Función para clasificar TODO el historial
function limpiarYClasificar() {
    try {
        if (fs.existsSync(CHAT_HISTORY_FILE)) {
            let chats = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8'));
            Object.keys(chats).forEach(id => {
                const c = chats[id];
                const texto = c.mensajes.map(m => m.texto.toLowerCase()).join(" ");
                let tags = [];
                // Si el cliente respondió (más de 1 mensaje) o habla de uniformes -> VMA
                if (c.mensajes.length > 1 || texto.match(/talla|uniforme|colegio|pantal|falda/)) {
                    tags.push("VENTA_VMA");
                }
                // Si habla de la clínica -> BODY
                if (texto.match(/body|evalua|hifu|lipo|clinica/)) {
                    tags.push("CITA_BODY");
                }
                chats[id].tags = [...new Set(tags)];
            });
            fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(chats, null, 2));
            console.log("✅ Historial re-clasificado");
        }
    } catch (e) { console.error("Error clasificando:", e); }
}

app.get('/limpiar-pestanas', (req, res) => {
    limpiarYClasificar();
    res.send("<h1>✅ Pestañas Re-Calculadas. Refresca el Monitor.</h1>");
});

app.get('/api/history', (req, res) => {
    if (fs.existsSync(CHAT_HISTORY_FILE)) res.json(JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8')));
    else res.json({});
});

app.get('/encender-zara', (req, res) => { botActivo = true; res.send("Despertando..."); });
app.get('/reset', (req, res) => {
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    process.exit(0);
});

app.listen(PORT, () => { 
    console.log("Servidor listo");
    limpiarYClasificar(); // Ejecutar al iniciar
});
