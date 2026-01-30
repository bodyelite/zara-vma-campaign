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

// === MONITOR LAYOUT WHATSAPP WEB === [cite: 2026-01-30]
app.get('/monitor', (req, res) => {
    const auth = req.headers.authorization;
    if (!auth || Buffer.from(auth.split(' ')[1], 'base64').toString().split(':')[1] !== MONITOR_PASSWORD) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Monitor"');
        return res.status(401).send('Acceso denegado');
    }

    const chats = fs.existsSync(CHAT_HISTORY_FILE) ? JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8')) : {};
    
    res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
        <meta charset="UTF-8">
        <meta http-equiv="refresh" content="10">
        <title>Zara Web Monitor</title>
        <style>
            body { margin: 0; font-family: Segoe UI, Helvetica Neue, Helvetica, Lucida Grande, Arial; background-color: #eae6df; display: flex; height: 100vh; }
            #side { width: 30%; background: white; border-right: 1px solid #d1d7db; overflow-y: auto; }
            #main { width: 70%; display: flex; flex-direction: column; background: #efeae2; }
            .header { background: #f0f2f5; padding: 10px 16px; display: flex; align-items: center; border-bottom: 1px solid #d1d7db; font-weight: bold; }
            .chat-list-item { padding: 12px 16px; border-bottom: 1px solid #f0f2f5; cursor: pointer; transition: 0.2s; }
            .chat-list-item:hover { background: #f5f6f6; }
            .chat-list-item .name { font-weight: 500; color: #111b21; }
            .chat-list-item .phone { font-size: 0.8em; color: #667781; }
            #messages { flex: 1; padding: 20px; overflow-y: auto; display: flex; flex-direction: column; }
            .msg { max-width: 65%; padding: 8px 12px; border-radius: 8px; margin-bottom: 4px; font-size: 14.2px; position: relative; box-shadow: 0 1px 0.5px rgba(11,20,26,.13); }
            .msg.zara { align-self: flex-end; background-color: #d9fdd3; color: #111b21; }
            .msg.cliente { align-self: flex-start; background-color: #fff; color: #111b21; }
            .msg .time { font-size: 10px; color: #667781; text-align: right; margin-top: 4px; }
        </style>
    </head>
    <body>
        <div id="side">
            <div class="header">Chats Recientes</div>
            ${Object.keys(chats).reverse().map(jid => `
                <div class="chat-list-item">
                    <div class="name">${chats[jid].nombre}</div>
                    <div class="phone">+${jid.split('@')[0]}</div>
                </div>
            `).join('')}
        </div>
        <div id="main">
            <div class="header">Consola de Conversación Activa</div>
            <div id="messages">
                ${Object.keys(chats).reverse().map(jid => `
                    <div style="text-align:center; font-size: 12px; margin: 20px 0; color: #667781; border-bottom: 1px dashed #ccc;">Historial con +${jid.split('@')[0]}</div>
                    ${chats[jid].mensajes.map(m => `
                        <div class="msg ${m.from === 'Zara' ? 'zara' : 'cliente'}">
                            ${m.texto}
                            <div class="time">${m.hora}</div>
                        </div>
                    `).join('')}
                `).join('')}
            </div>
        </div>
    </body>
    </html>
    `);
});

// Ruta de disparo masivo [cite: 2026-01-30]
app.get('/iniciar-envio', async (req, res) => {
    if (!sock) return res.send("Error: Desconectado");
    const filas = fs.readFileSync(CLIENTES_FILE, 'utf-8').split('\n').filter(l => l.trim() !== "");
    for (const linea of filas.slice(1)) {
        const [fono, nombre] = linea.split(',');
        if (fono) {
            const jid = fono.trim() + "@s.whatsapp.net";
            const msg = `Hola ${nombre.trim()}, soy Camila de VMA. ¿Te ayudo con los uniformes?`;
            await sock.sendMessage(jid, { text: msg });
            registrarChat(jid, nombre.trim(), msg, true);
            await delay(5000);
        }
    }
    res.send("Campaña lanzada");
});

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState("/data/auth_info_baileys");
    sock = makeWASocket({ auth: state, logger: pino({ level: "error" }), printQRInTerminal: false, browser: ["Ubuntu", "Chrome", "20.0.04"] });
    sock.ev.on("connection.update", (u) => { if (u.connection === "open") console.log("✅ Zara Online"); if (u.connection === "close") connectToWhatsApp(); });
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
