const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require("@whiskeysockets/baileys");
const pino = require("pino");
const express = require("express");
const fs = require("fs");
const path = require("path");
const ExcelJS = require('exceljs');
const { chatWithGPT } = require("./services/chatgpt");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const MONITOR_PASSWORD = process.env.MONITOR_PASSWORD || "123456";
const CHAT_HISTORY_FILE = "/data/historial_chats.json";
const CLIENTES_FILE = path.join(__dirname, "data", "clientes.csv");

// EQUIPOS
const STAFF_VMA = ["56971350852@s.whatsapp.net", "56998251331@s.whatsapp.net"]; 
const STAFF_BODY = ["56983300262@s.whatsapp.net", "56955145504@s.whatsapp.net", "56937648536@s.whatsapp.net"];

let sock;

// Función simple de logs
function log(msg) {
    console.log(`[LOG] ${new Date().toLocaleTimeString()} - ${msg}`);
}

async function enviarAlerta(grupo, mensaje) {
    if (!sock) return;
    for (const numero of grupo) {
        try { await sock.sendMessage(numero, { text: mensaje }); } catch (e) {}
    }
}

function registrarChat(jid, nombre, mensaje, esBot = false) {
    // Versión simplificada a prueba de fallos
    try {
        let chats = {};
        if (fs.existsSync(CHAT_HISTORY_FILE)) chats = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8'));
        
        const fonoLimpio = jid.replace('@s.whatsapp.net', '').replace('@lid', '').split(':')[0];
        
        if (!chats[fonoLimpio]) chats[fonoLimpio] = { nombre, mensajes: [], unread: 0, lastTs: 0 };
        
        chats[fonoLimpio].mensajes.push({
            hora: new Date().toLocaleTimeString('es-CL'),
            texto: mensaje,
            from: esBot ? 'Zara' : 'Cliente'
        });
        chats[fonoLimpio].lastTs = Date.now();
        if (!esBot) chats[fonoLimpio].unread = (chats[fonoLimpio].unread || 0) + 1;
        else chats[fonoLimpio].unread = 0;
        
        if (chats[fonoLimpio].mensajes.length > 60) chats[fonoLimpio].mensajes.shift();
        fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(chats, null, 2));
        return true; 
    } catch (e) {
        log("Error guardando chat: " + e.message);
        return false;
    }
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState("/data/auth_info_baileys");
    
    // LOG LEVEL INFO para ver si se desconecta
    sock = makeWASocket({ 
        auth: state, 
        logger: pino({ level: "info" }), 
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    sock.ev.on("connection.update", (u) => {
        const { connection, lastDisconnect } = u;
        if (connection === "close") {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            log(`Conexión cerrada. Reconectando: ${shouldReconnect}`);
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === "open") {
            log("✅ ZARA ONLINE - CONEXIÓN ESTABLECIDA");
        }
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async ({ messages }) => {
        try {
            log("EVENTO RAW RECIBIDO (Alguien escribió algo)"); // ESTO DEBE SALIR SI O SI
            
            const msg = messages[0];
            if (!msg.message) return;
            if (msg.key.fromMe) {
                log("Ignorando mensaje propio (fromMe)");
                return;
            }

            const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
            
            if (text) {
                log(`📩 MENSAJE DE ${msg.key.remoteJid}: ${text}`);
                
                // JID SIMPLE (Sin funciones raras)
                const remoteJid = msg.key.remoteJid;
                const nombre = msg.pushName || "Cliente";

                // 1. Guardar
                registrarChat(remoteJid, nombre, text, false);

                // 2. IA
                log("🤖 Preguntando a GPT...");
                const response = await chatWithGPT(text, remoteJid);
                log(`✅ GPT Respondió: ${response}`);

                // 3. Responder
                await sock.sendMessage(remoteJid, { text: response });
                registrarChat(remoteJid, nombre, response, true);

            } else {
                log("Mensaje recibido pero sin texto (sticker, audio, etc)");
            }
        } catch (e) {
            console.error("❌ ERROR FATAL EN UPSERT:", e);
        }
    });
}

// Rutas Express Esenciales
app.get('/api/history', (req, res) => {
    if (fs.existsSync(CHAT_HISTORY_FILE)) res.json(JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8')));
    else res.json({});
});

app.get('/monitor', (req, res) => {
    const auth = req.headers.authorization;
    if (!auth || Buffer.from(auth.split(' ')[1], 'base64').toString().split(':')[1] !== MONITOR_PASSWORD) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Monitor"');
        return res.status(401).send('Acceso denegado');
    }
    res.sendFile(path.join(__dirname, 'public/monitor.html'));
});

app.get('/iniciar-envio', async (req, res) => {
    if (!sock) return res.send("Error: WhatsApp Desconectado");
    if (!fs.existsSync(CLIENTES_FILE)) return res.send("Error: No existe el archivo CSV");
    
    const filas = fs.readFileSync(CLIENTES_FILE, 'utf-8').split('\n').filter(l => l.trim() !== "");
    res.write("Enviando...\n");
    
    for (const linea of filas.slice(1)) {
        const [fono, nombre] = linea.split(',');
        if (fono) {
            const jid = fono.trim() + "@s.whatsapp.net";
            const msg = `Hola ${nombre.trim()}, soy Camila de VMA. ¿Te ayudo con los uniformes?`;
            try {
                await sock.sendMessage(jid, { text: msg });
                registrarChat(jid, nombre.trim(), msg, true);
                res.write(`Enviado a ${nombre}\n`);
                await delay(4000);
            } catch (e) { console.error(e); }
        }
    }
    res.end("Finalizado.");
});

app.listen(PORT, () => { 
    log(`Servidor iniciado en puerto ${PORT}`); 
    connectToWhatsApp(); 
});
