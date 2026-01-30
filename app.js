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
            from: esBot ? 'Zara' : 'Cliente'
        });
        if (chats[jid].mensajes.length > 50) chats[jid].mensajes.shift();
        fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(chats, null, 2));
    } catch (e) { console.error(e); }
}

// === MONITOR ESTILO ZARA (SIMPLIFICADO) === [cite: 2025-12-29, 2026-01-30]
app.get('/monitor', (req, res) => {
    const auth = req.headers.authorization;
    if (!auth || Buffer.from(auth.split(' ')[1], 'base64').toString().split(':')[1] !== MONITOR_PASSWORD) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Monitor"');
        return res.status(401).send('Acceso denegado');
    }
    let htmlChats = '<p>Sin actividad reciente.</p>';
    if (fs.existsSync(CHAT_HISTORY_FILE)) {
        const chats = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8'));
        htmlChats = Object.keys(chats).reverse().map(jid => `
            <div style="border:1px solid #ccc; padding:10px; margin-bottom:10px; font-family:monospace;">
                <b>CONTACTO: ${chats[jid].nombre} (${jid.split('@')[0]})</b>
                <div style="margin-top:5px; border-top:1px solid #eee; padding-top:5px;">
                    ${chats[jid].mensajes.map(m => `
                        <div style="color:${m.from === 'Zara' ? 'blue' : 'black'}">
                            [${m.hora}] ${m.from}: ${m.texto}
                        </div>
                    `).join('')}
                </div>
            </div>
        `).join('');
    }
    res.send(`<html><head><meta http-equiv="refresh" content="5"></head><body><h2>Monitor Zara - VMA Campaign</h2>${htmlChats}</body></html>`);
});

app.get('/iniciar-envio', async (req, res) => {
    if (!sock) return res.send("Error: WhatsApp desconectado");
    const lineas = fs.readFileSync(CLIENTES_FILE, 'utf-8').split('\n').filter(l => l.trim() !== "");
    for (const linea of lineas.slice(1)) {
        const [fono, nombre] = linea.split(',');
        if (fono) {
            const jid = fono.trim() + "@s.whatsapp.net";
            const msg = `Hola ${nombre.trim()}, soy Camila de VMA. ¿Te ayudo con los uniformes?`;
            await sock.sendMessage(jid, { text: msg });
            registrarChat(jid, nombre.trim(), msg, true);
            await delay(5000);
        }
    }
    res.send("Envío procesado.");
});

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState("/data/auth_info_baileys");
    sock = makeWASocket({ auth: state, logger: pino({ level: "error" }), printQRInTerminal: false, browser: ["Ubuntu", "Chrome", "20.0.04"] });
    sock.ev.on("connection.update", (u) => { if (u.connection === "close") connectToWhatsApp(); });
    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (text) {
            registrarChat(msg.key.remoteJid, msg.pushName || "Cliente", text, false);
            const response = await chatWithGPT(text, msg.key.remoteJid);
            await sock.sendMessage(msg.key.remoteJid, { text: response });
            registrarChat(msg.key.remoteJid, msg.pushName || "Cliente", response, true);
        }
    });
}

app.listen(PORT, () => { console.log(`Puerto ${PORT}`); connectToWhatsApp(); });
