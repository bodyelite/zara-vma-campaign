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

// LÓGICA DE CLASIFICACIÓN AGRESIVA
function clasificarChat(chat) {
    let tags = [];
    const mensajes = chat.mensajes || [];
    const texto = mensajes.map(m => m.texto.toLowerCase()).join(" ");
    
    // REGLA DE ORO: Si hay más de un mensaje, el cliente interactuó -> Pasa a VMA
    if (mensajes.length > 1) {
        tags.push("VENTA_VMA");
    }
    
    // Regla adicional para Body Elite
    if (texto.includes("body") || texto.includes("evaluacion") || texto.includes("hifu")) {
        tags.push("CITA_BODY");
    }
    
    return [...new Set(tags)]; // Evitar duplicados
}

app.get('/limpiar-pestanas', (req, res) => {
    try {
        if (fs.existsSync(CHAT_HISTORY_FILE)) {
            let chats = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8'));
            Object.keys(chats).forEach(id => {
                chats[id].tags = clasificarChat(chats[id]);
            });
            fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(chats, null, 2));
            res.send("<h1>✅ Pestañas Re-Calculadas por Interacción. Refresca el Monitor.</h1>");
        } else { res.send("Sin historial."); }
    } catch (e) { res.status(500).send(e.message); }
});

app.get('/api/history', (req, res) => {
    if (fs.existsSync(CHAT_HISTORY_FILE)) {
        const chats = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8'));
        res.json(chats);
    } else res.json({});
});

app.get('/monitor', (req, res) => res.sendFile(path.join(__dirname, 'public/monitor.html')));
app.get('/estado', (req, res) => res.send(`<h1>${webStatus}</h1>`));
app.listen(PORT, () => { console.log("Servidor en línea"); });
