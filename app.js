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
const CLIENTES_FILE = path.join(__dirname, "data", "clientes.csv");
const AUTH_DIR = "/data/auth_info_baileys";

let sock;
let botActivo = false; // El bot inicia APAGADO por seguridad
let webStatus = "⏸️ MODO OBSERVADOR (Zara durmiendo)";
let webCode = "";

async function connectToWhatsApp() {
    if (!botActivo) return;
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    sock = makeWASocket({ auth: state, logger: pino({ level: "silent" }), browser: ["Ubuntu", "Chrome", "20.0.04"] });

    sock.ev.on("connection.update", async (u) => {
        const { connection, lastDisconnect } = u;
        if (connection === "open") { webStatus = "✅ ZARA ONLINE"; webCode = ""; }
        if (connection === "close") {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect && botActivo) connectToWhatsApp();
        }
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe || !botActivo) return;
        const jid = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (text) {
            const nombre = msg.pushName || "Cliente";
            const fono = jid.split('@')[0].replace(/\D/g, '');
            // Registrar y responder con GPT (usando buffering interno si es necesario)
            const response = await chatWithGPT(text, fono, []); // Historial simplificado por ahora
            await sock.sendMessage(jid, { text: response });
            // Lógica de registro en JSON aquí...
        }
    });
}

// CONTROL DE SEGURIDAD
app.get('/encender-zara', (req, res) => {
    botActivo = true; connectToWhatsApp();
    res.send("<h1>🚀 Orden recibida: Despertando a Zara...</h1><p>Ve a /estado para vincular.</p>");
});

app.get('/apagar-zara', (req, res) => {
    botActivo = false; if (sock) sock.end();
    webStatus = "⏸️ MODO OBSERVADOR (Zara durmiendo)";
    res.send("<h1>🛑 Zara se ha dormido. Monitor seguro.</h1>");
});

app.get('/estado', (req, res) => res.send(`<h1>${webStatus}</h1><h2>${webCode}</h2>`));
app.get('/monitor', (req, res) => res.sendFile(path.join(__dirname, 'public/monitor.html')));
app.get('/api/history', (req, res) => {
    if (fs.existsSync(CHAT_HISTORY_FILE)) res.json(JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8')));
    else res.json({});
});

app.listen(PORT, () => { console.log(`Monitor activo en puerto ${PORT}`); });
