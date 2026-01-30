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

function registrarChat(jid, nombre, mensaje, esBot = false) {
    let chats = {};
    try {
        if (fs.existsSync(CHAT_HISTORY_FILE)) chats = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8'));
        if (!chats[jid]) chats[jid] = { nombre, mensajes: [] };
        chats[jid].mensajes.push({
            hora: new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' }),
            texto: mensaje,
            from: esBot ? 'Camila' : 'Cliente'
        });
        if (chats[jid].mensajes.length > 30) chats[jid].mensajes.shift();
        fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(chats, null, 2));
    } catch (e) { console.error("Error monitor:", e); }
}

app.get('/monitor', (req, res) => {
    const auth = req.headers.authorization;
    if (!auth || Buffer.from(auth.split(' ')[1], 'base64').toString().split(':')[1] !== MONITOR_PASSWORD) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Monitor"');
        return res.status(401).send('Acceso denegado');
    }
    let htmlChats = '<p style="text-align:center;">No hay mensajes registrados aún en /data</p>';
    if (fs.existsSync(CHAT_HISTORY_FILE)) {
        const chats = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8'));
        htmlChats = Object.keys(chats).reverse().map(jid => `
            <div style="background:white; border-radius:10px; padding:15px; margin-bottom:15px; border-left:5px solid #0084ff;">
                <h4>👤 ${chats[jid].nombre} (${jid.split('@')[0]})</h4>
                <div style="font-size:0.9em; background:#f9f9f9; padding:10px; border-radius:5px;">
                    ${chats[jid].mensajes.map(m => `<p style="text-align:${m.from === 'Camila' ? 'right' : 'left'}"><b>${m.from}:</b> ${m.texto}</p>`).join('')}
                </div>
            </div>
        `).join('');
    }
    res.send(`<html><head><meta http-equiv="refresh" content="5"></head><body style="font-family:sans-serif; background:#f0f2f5; padding:20px;"><div style="max-width:700px; margin:auto;"><h1>💬 Monitor Camila VMA</h1>${htmlChats}</div></body></html>`);
});

app.get('/iniciar-envio', async (req, res) => {
    if (!sock) return res.send("Bot no iniciado");
    const filas = fs.readFileSync(CLIENTES_FILE, 'utf-8').split('\n').filter(l => l.trim() !== "");
    for (const linea of filas) {
        const [fono, nombre] = linea.split(',');
        if (fono && fono.length > 8) {
            const jid = fono.trim() + "@s.whatsapp.net";
            const texto = `Hola ${nombre.trim()}, soy Camila de VMA. ¿Te ayudo con los uniformes?`;
            await sock.sendMessage(jid, { text: texto });
            registrarChat(jid, nombre.trim(), texto, true);
            await delay(5000);
        }
    }
    res.send("Campaña iniciada");
});

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState("/data/auth_info_baileys");
    sock = makeWASocket({
        auth: state,
        logger: pino({ level: "error" }),
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    sock.ev.on("connection.update", (u) => {
        if (u.connection === "open") console.log("✅ SISTEMA ONLINE");
        if (u.connection === "close") connectToWhatsApp();
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== 'notify') return; // Ignora mensajes antiguos de sincronización [cite: 2026-01-30]
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const jid = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        
        if (text) {
            console.log(`📩 Mensaje de ${jid}: ${text}`);
            registrarChat(jid, msg.pushName || "Cliente", text, false);
            const response = await chatWithGPT(text, jid);
            await sock.sendMessage(jid, { text: response });
            registrarChat(jid, msg.pushName || "Cliente", response, true);
        }
    });

    sock.ev.on("creds.update", saveCreds);
}

app.listen(PORT, () => {
    console.log(`Servidor en puerto ${PORT}`);
    connectToWhatsApp();
});
