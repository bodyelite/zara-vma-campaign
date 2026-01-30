const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require("@whiskeysockets/baileys");
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
app.use(express.static("public"));

// === CONFIGURACIÓN DE STAFF Y ALERTAS ===
const STAFF_VMA = ["56971350852", "56998251331"]; // Cinthya y Vivi [cite: 2026-01-09]
const STAFF_BODY = ["56983300262", "56937648536", "56955145504"]; // Recepción, JC y Valentina [cite: 2026-01-09]

const PORT = process.env.PORT || 3000;
const MONITOR_PASSWORD = process.env.MONITOR_PASSWORD || "admin123";

let sock;

// Función para enviar alertas a WhatsApp
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

// === MONITOR WEB PROTEGIDO ===
app.get('/monitor', (req, res) => {
    const auth = req.headers.authorization;
    if (!auth || Buffer.from(auth.split(' ')[1], 'base64').toString().split(':')[1] !== MONITOR_PASSWORD) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Monitor VMA"');
        return res.status(401).send('Acceso denegado');
    }
    res.send("<h1>📊 Monitor VMA & Body Elite Activo</h1><p>Revisando disco /data...</p>");
});

async function connectToWhatsApp() {
    // PERSISTENCIA EN DISCO RENDER
    const { state, saveCreds } = await useMultiFileAuthState("/data/auth_info_baileys");
    
    sock = makeWASocket({
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        auth: state,
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    // Pairing code logic...
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
        } else if (connection === "open") {
            console.log("✅ Camila VMABE conectada en Render.");
        }
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

            // Lógica de disparo de alertas
            if (gptResponse.includes("$")) { // Si hay precios, alerta a VMA
                await enviarAlerta('VMA', { nombre: userName, telefono: jid.split('@')[0], fecha: "Verificar chat" });
            }
            if (gptResponse.toLowerCase().includes("body elite")) { // Si se ofrece Body, alerta a su staff
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