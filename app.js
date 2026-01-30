const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const pino = require("pino");
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { chatWithGPT } = require("./services/chatgpt");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// === CONFIGURACIÓN DE STAFF Y ALERTAS === [cite: 2026-01-09]
const STAFF_VMA = ["56971350852", "56998251331"]; 
const STAFF_BODY = ["56983300262", "56937648536", "56955145504"]; 

const PORT = process.env.PORT || 3000;
const MONITOR_PASSWORD = process.env.MONITOR_PASSWORD || "admin123";
const CHAT_HISTORY_FILE = "/data/historial_chats.json"; // Persistencia de chats

let sock;

// Función para registrar historial de chats en disco [cite: 2026-01-30]
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
        
        if (chats[jid].mensajes.length > 30) chats[jid].mensajes.shift();
        fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(chats, null, 2));
    } catch (e) { console.error("Error historial:", e); }
}

// Función para enviar alertas a WhatsApp [cite: 2026-01-09]
async function enviarAlerta(tipo, data) {
    const numeros = tipo === 'VMA' ? STAFF_VMA : STAFF_BODY;
    let mensaje = tipo === 'VMA' 
        ? `🚨 *NUEVA NOTA VMA*\n👤 ${data.nombre}\n📱 ${data.telefono}\n📅 Visita: ${data.fecha}`
        : `✨ *INTERÉS BODY ELITE*\n👤 ${data.nombre}\n📱 ${data.telefono}\n🎯 Evaluación Facial IA`;

    for (const num of numeros) {
        try {
            await sock.sendMessage(`${num}@s.whatsapp.net`, { text: mensaje });
        } catch (e) { console.error("Error alerta:", e); }
    }
}

// === MONITOR CON VISTA DE CHATS EN VIVO === [cite: 2026-01-30]
app.get('/monitor', (req, res) => {
    const auth = req.headers.authorization;
    if (!auth || Buffer.from(auth.split(' ')[1], 'base64').toString().split(':')[1] !== MONITOR_PASSWORD) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Monitor VMA"');
        return res.status(401).send('Acceso denegado');
    }

    let htmlChats = '<p style="text-align:center; color:#666;">Esperando nuevas conversaciones...</p>';
    if (fs.existsSync(CHAT_HISTORY_FILE)) {
        const chats = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8'));
        htmlChats = Object.keys(chats).reverse().map(jid => `
            <div style="background:white; border-radius:12px; padding:20px; margin-bottom:20px; box-shadow:0 2px 4px rgba(0,0,0,0.05); border-left:6px solid #0084ff;">
                <h3 style="margin:0 0 10px 0; color:#1c1e21; display:flex; justify-content:space-between;">
                    <span>👤 ${chats[jid].nombre}</span>
                    <small style="color:#888; font-weight:normal;">${jid.split('@')[0]}</small>
                </h3>
                <div style="background:#f7f8fa; border-radius:8px; padding:15px; max-height:250px; overflow-y:auto; font-size:0.95em;">
                    ${chats[jid].mensajes.map(m => `
                        <div style="margin-bottom:10px; text-align:${m.from === 'Camila' ? 'right' : 'left'}">
                            <span style="display:inline-block; padding:8px 12px; border-radius:15px; background:${m.from === 'Camila' ? '#0084ff' : '#e4e6eb'}; color:${m.from === 'Camila' ? 'white' : 'black'};">
                                <small style="display:block; font-size:0.7em; opacity:0.8;">${m.hora} - ${m.from}</small>
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
            <head>
                <title>Consola Camila VMA</title>
                <meta http-equiv="refresh" content="15">
                <style>
                    body { font-family:-apple-system, sans-serif; background:#f0f2f5; padding:20px; color:#1c1e21; }
                    .container { max-width:800px; margin:auto; }
                    .header { text-align:center; margin-bottom:30px; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="header">
                        <h1>💬 Conversaciones en Vivo</h1>
                        <p>● Sistema Conectado en Disco /data</p>
                    </div>
                    ${htmlChats}
                </div>
            </body>
        </html>
    `);
});

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState("/data/auth_info_baileys");
    
    sock = makeWASocket({
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        auth: state,
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    if (!sock.authState.creds.registered) {
        const phoneNumber = process.env.NUMERO_WSP_A_VINCULAR;
        if (phoneNumber) {
            setTimeout(async () => {
                const code = await sock.requestPairingCode(phoneNumber);
                console.log("CODIGO DE VINCULACIÓN:", code);
            }, 3000);
        }
    }

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === "close") {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === "open") console.log("✅ Camila VMABE conectada en Render.");
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const jid = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        const userName = msg.pushName || "Cliente";

        if (text) {
            registrarChat(jid, userName, text, false);
            const gptResponse = await chatWithGPT(text, jid);
            await sock.sendMessage(jid, { text: gptResponse });
            registrarChat(jid, userName, gptResponse, true);

            if (gptResponse.includes("$")) {
                await enviarAlerta('VMA', { nombre: userName, telefono: jid.split('@')[0], fecha: "Ver Monitor" });
            }
            if (gptResponse.toLowerCase().includes("body elite")) {
                await enviarAlerta('BODY', { nombre: userName, telefono: jid.split('@')[0] });
            }
        }
    });

    sock.ev.on("creds.update", saveCreds);
}

app.listen(PORT, () => {
    console.log(`Servidor en puerto ${PORT}`);
    connectToWhatsApp();
});
