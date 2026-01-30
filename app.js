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
const LOG_FILE = "/data/pedidos_log.json"; // Archivo para el reporte en disco persistente

let sock;

// Función para registrar pedidos en el log
function registrarEvento(tipo, data) {
    let logs = [];
    try {
        if (fs.existsSync(LOG_FILE)) logs = JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8'));
        logs.push({ fecha: new Date().toLocaleString(), tipo, ...data });
        fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
    } catch (e) { console.error("Error logueando:", e); }
}

// Función para enviar alertas a WhatsApp [cite: 2026-01-09]
async function enviarAlerta(tipo, data) {
    const numeros = tipo === 'VMA' ? STAFF_VMA : STAFF_BODY;
    let mensaje = tipo === 'VMA' 
        ? `🚨 *NUEVA NOTA VMA*\n👤 ${data.nombre}\n📱 ${data.telefono}\n📅 Visita: ${data.fecha}`
        : `✨ *INTERÉS BODY ELITE*\n👤 ${data.nombre}\n📱 ${data.telefono}\n🎯 Evaluación Facial IA`;

    registrarEvento(tipo, data);
    for (const num of numeros) {
        try {
            await sock.sendMessage(`${num}@s.whatsapp.net`, { text: mensaje });
        } catch (e) { console.error("Error alerta:", e); }
    }
}

// === MONITOR WEB CON BOTÓN DE REPORTE === [cite: 2026-01-30]
app.get('/monitor', (req, res) => {
    const auth = req.headers.authorization;
    if (!auth || Buffer.from(auth.split(' ')[1], 'base64').toString().split(':')[1] !== MONITOR_PASSWORD) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Monitor VMA"');
        return res.status(401).send('Acceso denegado');
    }
    res.send(`
        <html>
            <head>
                <title>Monitor Camila</title>
                <style>
                    body { font-family: sans-serif; padding: 40px; background: #f0f2f5; }
                    .card { background: white; padding: 25px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); max-width: 600px; margin: auto; }
                    h1 { color: #1c1e21; border-bottom: 2px solid #eee; padding-bottom: 10px; }
                    .btn { background: #0084ff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block; margin-top: 20px; cursor: pointer; border: none; }
                    .status { color: #42b72a; font-weight: bold; }
                </style>
            </head>
            <body>
                <div class="card">
                    <h1>📊 Panel Camila VMA</h1>
                    <p class="status">● Sistema Conectado en Render Cloud</p>
                    <p>📍 <b>Disco:</b> /data</p>
                    <p>📩 <b>Alertas:</b> Activas para Staff VMA y Body Elite</p>
                    <hr>
                    <button class="btn" onclick="window.location.href='/download-report'">📥 Descargar Reporte de Pedidos</button>
                </div>
            </body>
        </html>
    `);
});

app.get('/download-report', (req, res) => {
    if (fs.existsSync(LOG_FILE)) res.download(LOG_FILE);
    else res.status(404).send("No hay pedidos registrados aún.");
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
            const gptResponse = await chatWithGPT(text, jid);
            await sock.sendMessage(jid, { text: gptResponse });

            if (gptResponse.includes("$")) {
                await enviarAlerta('VMA', { nombre: userName, telefono: jid.split('@')[0], fecha: "Ver chat" });
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
