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

// --- NÚMERO DEL BOT PARA VINCULACIÓN ---
const BOT_NUMBER = "56934424673"; // Extraído de tus logs anteriores

// --- BORRADO DE SESIÓN CORRUPTA ---
try {
    if (fs.existsSync(AUTH_DIR)) {
        console.log("♻️ BORRANDO SESIÓN ANTIGUA (Modo Re-Vinculación)...");
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
        try { await sock.sendMessage(numero, { text: mensaje }); } catch (e) {}
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
        printQRInTerminal: false, // APAGAMOS QR para usar Código
        logger: pino({ level: "silent" }), // Menos ruido
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    // --- SOLICITUD DE CÓDIGO DE VINCULACIÓN ---
    if (!sock.authState.creds.registered) {
        console.log("⏳ ESPERANDO GENERAR CÓDIGO DE VINCULACIÓN...");
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(BOT_NUMBER);
                console.log("\n==================================================");
                console.log("🔑 TU CÓDIGO DE VINCULACIÓN ES:  " + code?.match(/.{1,4}/g)?.join("-"));
                console.log("==================================================\n");
                console.log("👉 Ve a WhatsApp > Dispositivos Vinculados > Vincular con número de teléfono");
            } catch (e) {
                console.error("❌ Error pidiendo código:", e.message);
            }
        }, 4000);
    }

    sock.ev.on("connection.update", (u) => {
        const { connection, lastDisconnect } = u;
        if (connection === "close") {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === "open") {
            console.log("✅ ZARA ONLINE - CONECTADO Y LISTO");
        }
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async ({ messages }) => {
        try {
            const msg = messages[0];
            if (!msg.message || msg.key.fromMe) return;
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
            if (text) {
                let realJid = msg.key.remoteJid;
                // Intento seguro de normalizar
                try {
                     if (typeof jidNormalizedUser === 'function') {
                        realJid = jidNormalizedUser(msg.key.remoteJid);
                        if (msg.key.participant) realJid = jidNormalizedUser(msg.key.participant);
                     }
                } catch(e) {}

                const nombre = msg.pushName || "Cliente";
                
                const esNuevo = registrarChat(realJid, nombre, text, false);
                // ALERTA DE NUEVO
                if (esNuevo) {
                     const fono = realJid.split('@')[0];
                     await enviarAlerta(STAFF_VMA, `🔔 NUEVO: ${nombre} (+${fono})`);
                }

                // RESPUESTA IA
                try {
                    const response = await chatWithGPT(text, realJid);
                    await sock.sendMessage(msg.key.remoteJid, { text: response });
                    registrarChat(realJid, nombre, response, true);
                    
                    // ALERTA AGENDA/BODY
                    const botTxt = response.toLowerCase();
                    const userTxt = text.toLowerCase();
                    const fono = realJid.split('@')[0];

                    if (botTxt.includes("agendado") && botTxt.includes("body")) {
                        await enviarAlerta(STAFF_BODY, `📅 AGENDADO BODY: ${nombre} (+${fono})`);
                    }
                    if (botTxt.includes("resumen final")) {
                         await enviarAlerta(STAFF_VMA, `✅ PEDIDO OK: ${nombre} (+${fono})`);
                    }

                } catch (gptError) {
                    console.error("Error IA:", gptError);
                    await sock.sendMessage(msg.key.remoteJid, { text: "Dame un segundo, estoy revisando... 🌸" });
                }
            }
        } catch (e) { console.error("Error Upsert:", e); }
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
app.get('/iniciar-envio', async (req, res) => {
    if (!sock) return res.send("Error: WhatsApp Desconectado");
    if (!fs.existsSync(CLIENTES_FILE)) return res.send("Error: No existe data/clientes.csv");
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
                res.write(`OK: ${nombre}\n`);
                await delay(5000);
            } catch (e) { console.error(e); }
        }
    }
    res.end("Finalizado.");
});

app.listen(PORT, () => { console.log(`Puerto ${PORT}`); connectToWhatsApp(); });
