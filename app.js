const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay, jidNormalizedUser } = require("@whiskeysockets/baileys");
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
const AUTH_DIR = "/data/auth_info_baileys";
const BOT_NUMBER = "56934424673"; // Tu número de bot

// --- BORRADO DE SESIÓN 401 (OBLIGATORIO PARA REVINCULAR) ---
try {
    if (fs.existsSync(AUTH_DIR)) {
        console.log("♻️ DETECTADO ERROR 401: BORRANDO SESIÓN PARA NUEVO CÓDIGO...");
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
} catch (e) { console.error("Error limpieza:", e); }

// EQUIPOS ALERTA
const STAFF_VMA = ["56971350852@s.whatsapp.net", "56998251331@s.whatsapp.net"]; 
const STAFF_BODY = ["56983300262@s.whatsapp.net", "56955145504@s.whatsapp.net", "56937648536@s.whatsapp.net"];

let sock;

async function enviarAlerta(grupo, mensaje) {
    if (!sock) return;
    for (const numero of grupo) {
        try { 
            await delay(2000); 
            await sock.sendMessage(numero, { text: mensaje }); 
        } catch (e) {}
    }
}

function registrarChat(jid, nombre, mensaje, esBot = false) {
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
    } catch (e) { return false; }
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    
    sock = makeWASocket({ 
        auth: state, 
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        browser: ["Mac OS", "Chrome", "10.15.7"], // Usamos Mac para estabilidad
        syncFullHistory: false
    });

    // SOLICITUD DE CÓDIGO NUEVO
    if (!sock.authState.creds.registered) {
        console.log("⏳ ESPERANDO CÓDIGO DE VINCULACIÓN...");
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(BOT_NUMBER);
                console.log("\n==================================================");
                console.log("🔑 CÓDIGO NUEVO:  " + code?.match(/.{1,4}/g)?.join("-"));
                console.log("==================================================\n");
            } catch (e) { console.error("❌ Error código:", e.message); }
        }, 5000);
    }

    sock.ev.on("connection.update", (u) => {
        const { connection, lastDisconnect } = u;
        if (connection === "close") {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut; // Si es 401 (LoggedOut), NO reconecta solo, requiere código
            console.log(`❌ Conexión cerrada (Code: ${statusCode}). Reconectando: ${shouldReconnect}`);
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === "open") {
            console.log("✅ ZARA ONLINE - CONECTADO");
        }
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async ({ messages }) => {
        try {
            const msg = messages[0];
            if (!msg.message || msg.key.fromMe) return;
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
            if (text) {
                console.log(`📩 Recibido: ${text.substring(0, 10)}...`);
                let realJid = msg.key.remoteJid;
                try {
                     if (typeof jidNormalizedUser === 'function') {
                        realJid = jidNormalizedUser(msg.key.remoteJid);
                        if (msg.key.participant) realJid = jidNormalizedUser(msg.key.participant);
                     }
                } catch(e) {}
                const nombre = msg.pushName || "Cliente";
                
                const esNuevo = registrarChat(realJid, nombre, text, false);
                if (esNuevo) {
                     const fono = realJid.split('@')[0];
                     await enviarAlerta(STAFF_VMA, `🔔 NUEVO: ${nombre} (+${fono})`);
                }

                try {
                    const response = await chatWithGPT(text, realJid);
                    await sock.sendMessage(msg.key.remoteJid, { text: response });
                    registrarChat(realJid, nombre, response, true);
                    
                    const botTxt = response.toLowerCase();
                    const fono = realJid.split('@')[0];
                    if (botTxt.includes("agendado") && botTxt.includes("body")) {
                        await enviarAlerta(STAFF_BODY, `📅 AGENDADO BODY: ${nombre} (+${fono})`);
                    }
                    if (botTxt.includes("resumen final")) {
                         await enviarAlerta(STAFF_VMA, `✅ PEDIDO OK: ${nombre} (+${fono})`);
                    }
                } catch (gptError) { console.error("Error IA:", gptError); }
            }
        } catch (e) { console.error("Upsert error:", e.message); }
    });
}

// Rutas
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

// ENVÍO LENTO (20 SEGUNDOS)
app.get('/iniciar-envio', async (req, res) => {
    if (!sock) return res.send("Error: Bot desconectado");
    if (!fs.existsSync(CLIENTES_FILE)) return res.send("Error: Falta clientes.csv");
    
    const filas = fs.readFileSync(CLIENTES_FILE, 'utf-8').split('\n').filter(l => l.trim() !== "");
    res.write("Iniciando envio LENTO (20s)...\n");
    
    for (let i = 1; i < filas.length; i++) {
        const linea = filas[i];
        const [fono, nombre] = linea.split(',');
        if (fono && fono.length > 8) {
            const jid = fono.trim() + "@s.whatsapp.net";
            const msg = `Hola ${nombre.trim()}, soy Camila de VMA. ¿Te ayudo con los uniformes?`;
            try {
                await sock.sendMessage(jid, { text: msg });
                registrarChat(jid, nombre.trim(), msg, true);
                res.write(`✅ Enviado a ${nombre} (${i}/${filas.length-1})\n`);
                
                // PAUSA DE 20 SEGUNDOS
                await delay(20000); 
                
            } catch (e) { 
                res.write(`❌ Error ${nombre}: ${e.message}\n`);
                await delay(5000);
            }
        }
    }
    res.end("Campaña finalizada.");
});

app.listen(PORT, () => { console.log(`Puerto ${PORT}`); connectToWhatsApp(); });
