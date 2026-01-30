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
        if (chats[jid].mensajes.length > 25) chats[jid].mensajes.shift();
        fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(chats, null, 2));
    } catch (e) { console.error("Error historial:", e); }
}

app.get('/iniciar-envio', async (req, res) => {
    if (!fs.existsSync(CLIENTES_FILE)) return res.status(404).send("Archivo clientes.csv no encontrado");
    const contenido = fs.readFileSync(CLIENTES_FILE, 'utf-8').split('\n').filter(l => l.trim() !== "");
    const filas = contenido.slice(0); // Tomamos todas las filas segun tu archivo actual

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.write("🚀 Iniciando campaña real...\n\n");

    for (const linea of filas) {
        const parts = linea.split(',');
        const fono = parts[0]?.trim();
        const nombre = parts[1]?.trim() || "Cliente";
        
        if (fono && fono.length > 8) {
            const jid = fono + "@s.whatsapp.net";
            const texto = `Hola ${nombre}, soy Camila de VMA. Te escribo para dejar listos los uniformes hoy y ahorrarte las filas de marzo 🏃💨. ¿Te ayudo con tallas o precios?`;
            
            try {
                await sock.sendMessage(jid, { text: texto });
                registrarChat(jid, nombre, texto, true);
                res.write(`✅ Enviado: ${nombre} (${fono})\n`);
                await delay(5000);
            } catch (err) {
                res.write(`❌ Error en ${nombre}: ${err.message}\n`);
            }
        }
    }
    res.end("\n🏁 Envío masivo completado.");
});

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState("/data/auth_info_baileys");
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        connectTimeoutMs: 60000, // Aumentado para evitar el bucle en Render
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs: 10000,
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === "close") {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log("Conexión cerrada. Razón:", reason);
            if (reason !== DisconnectReason.loggedOut) connectToWhatsApp();
        } else if (connection === "open") {
            console.log("✅ Camila Online y Estable");
        }
        
        if (update.pairingCode) {
            console.log("NUEVO CODIGO DE VINCULACIÓN:", update.pairingCode);
        }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const jid = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (text) {
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
