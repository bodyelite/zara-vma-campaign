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
        if (fs.existsSync(CHAT_HISTORY_FILE)) {
            chats = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8'));
        }
        const fonoLimpio = jid.split('@')[0];
        if (!chats[fonoLimpio]) chats[fonoLimpio] = { nombre, mensajes: [] };
        
        chats[fonoLimpio].mensajes.push({
            hora: new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' }),
            texto: mensaje,
            from: esBot ? 'Zara' : 'Cliente'
        });
        
        if (chats[fonoLimpio].mensajes.length > 50) chats[fonoLimpio].mensajes.shift();
        fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(chats, null, 2));
    } catch (e) { console.error(e); }
}

app.get('/monitor', (req, res) => {
    const auth = req.headers.authorization;
    if (!auth || Buffer.from(auth.split(' ')[1], 'base64').toString().split(':')[1] !== MONITOR_PASSWORD) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Monitor"');
        return res.status(401).send('Acceso denegado');
    }

    const chats = fs.existsSync(CHAT_HISTORY_FILE) ? JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8')) : {};
    
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <title>Zara Web Monitor</title>
        <script>
            setTimeout(() => { location.reload(); }, 10000);
            window.onload = () => { 
                const container = document.getElementById('messages-container');
                if(container) container.scrollTop = container.scrollHeight; 
            };
        </script>
        <style>
            body { margin: 0; font-family: 'Segoe UI', sans-serif; display: flex; height: 100vh; background: #f0f2f5; }
            #sidebar { width: 350px; background: white; border-right: 1px solid #d1d7db; display: flex; flex-direction: column; overflow-y: auto; }
            #chat-area { flex: 1; display: flex; flex-direction: column; background: #efeae2; }
            .header-bar { background: #f0f2f5; padding: 10px 16px; height: 40px; display: flex; align-items: center; border-bottom: 1px solid #d1d7db; font-weight: bold; color: #54656f; }
            .contact-item { padding: 15px; border-bottom: 1px solid #f0f2f5; }
            .contact-name { font-weight: 500; color: #111b21; display: block; }
            .contact-phone { font-size: 0.85em; color: #667781; }
            #messages-container { flex: 1; padding: 20px 50px; overflow-y: auto; display: flex; flex-direction: column; }
            .bubble { max-width: 65%; padding: 8px 12px; border-radius: 8px; margin-bottom: 8px; font-size: 14px; position: relative; box-shadow: 0 1px 1px rgba(0,0,0,0.1); }
            .bubble.zara { align-self: flex-end; background: #d9fdd3; }
            .bubble.cliente { align-self: flex-start; background: white; }
            .bubble .time { font-size: 10px; color: #667781; text-align: right; margin-top: 4px; }
        </style>
    </head>
    <body>
        <div id="sidebar">
            <div class="header-bar">Contactos</div>
            ${Object.keys(chats).reverse().map(fono => `
                <div class="contact-item">
                    <span class="contact-name">${chats[fono].nombre}</span>
                    <span class="contact-phone">📱 +${fono}</span>
                </div>
            `).join('')}
        </div>
        <div id="chat-area">
            <div class="header-bar">Monitor Zara Live</div>
            <div id="messages-container">
                ${Object.keys(chats).reverse().map(fono => `
                    <div style="text-align:center; color:#667781; font-size:11px; margin:20px 0; border-top:1px solid #d1d7db; padding-top:10px;">Chat con +${fono}</div>
                    ${chats[fono].mensajes.map(m => `
                        <div class="bubble ${m.from === 'Zara' ? 'zara' : 'cliente'}">
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

app.get('/iniciar-envio', async (req, res) => {
    if (!sock) return res.send("Error: No conectado");
    if (!fs.existsSync(CLIENTES_FILE)) return res.send("Error: Sin CSV");
    const filas = fs.readFileSync(CLIENTES_FILE, 'utf-8').split('\n').filter(l => l.trim() !== "");
    for (const linea of filas.slice(1)) {
        const [fono, nombre] = linea.split(',');
        if (fono) {
            const jid = fono.trim() + "@s.whatsapp.net";
            const msg = `Hola ${nombre.trim()}, soy Camila de VMA. ¿Te ayudo con los uniformes?`;
            try {
                await sock.sendMessage(jid, { text: msg });
                registrarChat(jid, nombre.trim(), msg, true);
                await delay(5000);
            } catch (e) { console.error(e); }
        }
    }
    res.send("Campaña lanzada");
});

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState("/data/auth_info_baileys");
    sock = makeWASocket({ auth: state, logger: pino({ level: "error" }), printQRInTerminal: false, browser: ["Ubuntu", "Chrome", "20.0.04"] });
    sock.ev.on("connection.update", (u) => { if (u.connection === "open") console.log("✅ Zara Online"); if (u.connection === "close") setTimeout(connectToWhatsApp, 5000); });
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

app.listen(PORT, () => {
    console.log(`Puerto ${PORT}`);
    connectToWhatsApp();
});
