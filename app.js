const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require("@whiskeysockets/baileys");
const pino = require("pino");
const express = require("express");
const fs = require("fs");
const path = require("path");
const { chatWithGPT } = require("./services/chatgpt");
require("dotenv").config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MONITOR_PASSWORD = process.env.MONITOR_PASSWORD || "123456";
const CHAT_HISTORY_FILE = "/data/historial_chats.json";
const CLIENTES_FILE = path.join(__dirname, "clientes.csv");

let sock;

// 1. MONITOR SIEMPRE ACTIVO [cite: 2026-01-30]
app.listen(PORT, () => { console.log(`✅ Monitor en puerto ${PORT}`); });

app.get('/monitor', (req, res) => {
    const auth = req.headers.authorization;
    if (!auth || Buffer.from(auth.split(' ')[1], 'base64').toString().split(':')[1] !== MONITOR_PASSWORD) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Monitor"');
        return res.status(401).send('Acceso denegado');
    }
    res.send(`<html><body style="font-family:sans-serif; padding:20px;"><h1>📊 Consola Camila</h1><p>Estado: Revisando Logs...</p></body></html>`);
});

// 2. CONEXIÓN FORZADA [cite: 2026-01-30]
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState("/data/auth_info_baileys");
    
    sock = makeWASocket({
        auth: state,
        logger: pino({ level: "info" }), // Subimos nivel para ver errores
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    // FORZAR CÓDIGO SI NO ESTÁ REGISTRADO [cite: 2026-01-30]
    if (!sock.authState.creds.registered) {
        const numero = "56934424673";
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(numero);
                console.log("🔑 TU CÓDIGO DE VINCULACIÓN ES:", code);
            } catch (e) { console.error("Error pidiendo código:", e); }
        }, 5000);
    }

    sock.ev.on("connection.update", (u) => {
        if (u.connection === "open") console.log("✅ CAMILA CONECTADA");
        if (u.connection === "close") setTimeout(connectToWhatsApp, 5000);
    });

    sock.ev.on("creds.update", saveCreds);
}

connectToWhatsApp();
