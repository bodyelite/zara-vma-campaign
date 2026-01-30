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

// 1. INICIAR MONITOR PRIMERO (Para que no se pierda) [cite: 2026-01-30]
app.listen(PORT, () => {
    console.log(`✅ Servidor Web activo en puerto ${PORT}`);
});

app.get('/monitor', (req, res) => {
    const auth = req.headers.authorization;
    if (!auth || Buffer.from(auth.split(' ')[1], 'base64').toString().split(':')[1] !== MONITOR_PASSWORD) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Monitor"');
        return res.status(401).send('Acceso denegado');
    }
    
    let htmlChats = '<p style="text-align:center;">Esperando actividad...</p>';
    if (fs.existsSync(CHAT_HISTORY_FILE)) {
        const chats = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8'));
        htmlChats = Object.keys(chats).reverse().map(jid => `
            <div style="background:white; border-radius:10px; padding:15px; margin-bottom:15px; border-left:5px solid #0084ff;">
                <h4>👤 ${chats[jid].nombre} (${jid.split('@')[0]})</h4>
                <div style="font-size:0.85em; background:#f9f9f9; padding:10px; border-radius:5px;">
                    ${chats[jid].mensajes.map(m => `<p><b>${m.from}:</b> ${m.texto}</p>`).join('')}
                </div>
            </div>
        `).join('');
    }
    res.send(`<html><head><meta http-equiv="refresh" content="10"></head><body style="font-family:sans-serif; background:#f0f2f5; padding:20px;"><div style="max-width:600px; margin:auto;"><h1>💬 Consola Camila</h1>${htmlChats}</div></body></html>`);
});

app.get('/iniciar-envio', async (req, res) => {
    if (!sock || !sock.authState.creds.registered) return res.send("❌ WhatsApp no está vinculado.");
    if (!fs.existsSync(CLIENTES_FILE)) return res.status(404).send("Archivo clientes.csv no encontrado");
    
    const filas = fs.readFileSync(CLIENTES_FILE, 'utf-8').split('\n').filter(l => l.trim() !== "");
    res.write("Enviando...\n");
    for (const linea of filas) {
        const [fono, nombre] = linea.split(',');
        if (fono && fono.length > 8) {
            try {
                await sock.sendMessage(fono.trim() + "@s.whatsapp.net", { text: `Hola ${nombre.trim()}, soy Camila...` });
                res.write(`✅ ${nombre}\n`);
                await delay(5000);
            } catch (e) { res.write(`❌ ${nombre}: ${e.message}\n`); }
        }
    }
    res.end("Campaña terminada.");
});

// 2. CONEXIÓN WHATSAPP CON TIMEOUTS ROBUSTOS [cite: 2026-01-30]
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState("/data/auth_info_baileys");
    
    sock = makeWASocket({
        auth: state,
        logger: pino({ level: "error" }),
        printQRInTerminal: false,
        connectTimeoutMs: 120000, // 2 minutos para el Cloud
        defaultQueryTimeoutMs: 0,
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, pairingCode } = update;
        if (pairingCode) console.log("🔑 NUEVO CÓDIGO:", pairingCode);
        
        if (connection === "close") {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) setTimeout(connectToWhatsApp, 5000);
        } else if (connection === "open") {
            console.log("✅ Camila Conectada!");
        }
    });

    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (text) {
            const response = await chatWithGPT(text, msg.key.remoteJid);
            await sock.sendMessage(msg.key.remoteJid, { text: response });
        }
    });
}

connectToWhatsApp();
