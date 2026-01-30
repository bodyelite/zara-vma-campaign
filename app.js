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
        if (!chats[jid]) chats[jid] = { nombre, mensajes: [] };
        chats[jid].mensajes.push({
            hora: new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' }),
            texto: mensaje,
            from: esBot ? 'Camila' : 'Cliente'
        });
        if (chats[jid].mensajes.length > 50) chats[jid].mensajes.shift();
        fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(chats, null, 2));
    } catch (e) { console.error("Error Monitor:", e); }
}

app.get('/monitor', (req, res) => {
    const auth = req.headers.authorization;
    if (!auth || Buffer.from(auth.split(' ')[1], 'base64').toString().split(':')[1] !== MONITOR_PASSWORD) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Monitor"');
        return res.status(401).send('Acceso denegado');
    }
    let htmlChats = '<p style="text-align:center; padding:20px;">Esperando actividad en tiempo real...</p>';
    if (fs.existsSync(CHAT_HISTORY_FILE)) {
        const chats = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8'));
        htmlChats = Object.keys(chats).reverse().map(jid => `
            <div style="background:white; border-radius:12px; padding:20px; margin-bottom:20px; border-left:6px solid #0084ff; box-shadow:0 2px 5px rgba(0,0,0,0.1);">
                <h3 style="margin:0 0 10px 0;">👤 ${chats[jid].nombre} <small style="font-weight:normal; color:#888;">(${jid.split('@')[0]})</small></h3>
                <div style="background:#f0f2f5; padding:15px; border-radius:8px; max-height:300px; overflow-y:auto;">
                    ${chats[jid].mensajes.map(m => `
                        <div style="margin-bottom:10px; text-align:${m.from === 'Camila' ? 'right' : 'left'}">
                            <span style="display:inline-block; padding:8px 12px; border-radius:15px; background:${m.from === 'Camila' ? '#0084ff' : '#ffffff'}; color:${m.from === 'Camila' ? 'white' : 'black'}; box-shadow:0 1px 2px rgba(0,0,0,0.1);">
                                ${m.texto}
                            </span>
                        </div>
                    `).join('')}
                </div>
            </div>
        `).join('');
    }
    res.send(`
        <html>
            <head><meta http-equiv="refresh" content="5"><title>Consola Camila</title></head>
            <body style="font-family:-apple-system, sans-serif; background:#f0f2f5; padding:20px;">
                <div style="max-width:800px; margin:auto;">
                    <h1 style="text-align:center;">💬 Camila VMA Live</h1>
                    ${htmlChats}
                </div>
            </body>
        </html>
    `);
});

app.get('/iniciar-envio', async (req, res) => {
    if (!sock) return res.send("Bot no conectado");
    if (!fs.existsSync(CLIENTES_FILE)) return res.send("CSV no encontrado");
    
    const lineas = fs.readFileSync(CLIENTES_FILE, 'utf-8').split('\n').filter(l => l.trim() !== "");
    const filas = lineas.slice(1);
    
    res.setHeader('Content-Type', 'text/plain');
    res.write("Lanzando campaña...\n");
    
    for (const linea of filas) {
        const [fono, nombre] = linea.split(',');
        if (fono) {
            const jid = fono.trim() + "@s.whatsapp.net";
            const texto = `Hola ${nombre.trim()}, soy Camila de VMA. ¿Te ayudo con los uniformes?`;
            try {
                await sock.sendMessage(jid, { text: texto });
                registrarChat(jid, nombre.trim(), texto, true);
                res.write(`✅ ${nombre}\n`);
                await delay(5000);
            } catch (e) { res.write(`❌ ${nombre}: ${e.message}\n`); }
        }
    }
    res.end("Campaña completada.");
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
        if (u.connection === "close") setTimeout(connectToWhatsApp, 5000);
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const jid = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;

        if (text) {
            console.log(`📩 Entrada de ${jid}: ${text}`);
            registrarChat(jid, msg.pushName || "Cliente", text, false);
            try {
                const response = await chatWithGPT(text, jid);
                await sock.sendMessage(jid, { text: response });
                registrarChat(jid, msg.pushName || "Cliente", response, true);
            } catch (err) { console.error("Error GPT/WSP:", err); }
        }
    });
}

app.listen(PORT, () => {
    console.log(`Servidor en puerto ${PORT}`);
    connectToWhatsApp();
});
