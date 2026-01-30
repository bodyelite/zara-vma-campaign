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
let botActivo = false; // INTERRUPTOR DE SEGURIDAD: Inicia apagado

let sock;
let webStatus = "⏸️ MODO OBSERVADOR (Bot Desactivado)";

async function connectToWhatsApp() {
    if (!botActivo) return; // Si no está activo, no hace nada
    
    webStatus = "⏳ Intentando conectar...";
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    sock = makeWASocket({ auth: state, logger: pino({ level: "silent" }), browser: ["Ubuntu", "Chrome", "20.0.04"] });

    sock.ev.on("connection.update", (u) => {
        const { connection } = u;
        if (connection === "open") webStatus = "✅ ZARA ONLINE";
        if (connection === "close") { webStatus = "❌ Desconectado"; setTimeout(connectToWhatsApp, 5000); }
    });

    sock.ev.on("creds.update", saveCreds);
    // ... resto de la lógica de mensajes se mantiene interna ...
}

// NUEVAS RUTAS DE CONTROL
app.get('/encender-zara', (req, res) => {
    botActivo = true;
    connectToWhatsApp();
    res.send("<h1>🚀 Bot Activado. Intentando conectar a WhatsApp...</h1>");
});

app.get('/apagar-zara', (req, res) => {
    botActivo = false;
    if (sock) sock.logout();
    webStatus = "⏸️ MODO OBSERVADOR (Bot Desactivado)";
    res.send("<h1>🛑 Bot Apagado. Monitor seguro.</h1>");
});

app.get('/estado', (req, res) => res.send(`<h1>${webStatus}</h1>`));
app.get('/monitor', (req, res) => res.sendFile(path.join(__dirname, 'public/monitor.html')));
app.get('/api/history', (req, res) => {
    if (fs.existsSync(CHAT_HISTORY_FILE)) res.json(JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8')));
    else res.json({});
});

app.listen(PORT, () => { 
    console.log(`Monitor corriendo en puerto ${PORT}`);
    // No llamamos a connectToWhatsApp automáticamente
});
