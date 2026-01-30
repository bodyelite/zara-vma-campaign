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

// --- CONFIGURACIÓN ---
const PORT = process.env.PORT || 3000;
const MONITOR_PASSWORD = process.env.MONITOR_PASSWORD || "123456";
const CHAT_HISTORY_FILE = "/data/historial_chats.json";
const CLIENTES_FILE = path.join(__dirname, "data", "clientes.csv");
const AUTH_DIR = "/data/auth_info_baileys";
const BOT_NUMBER = "56934424673"; 

// --- ESTADO ---
let sock;
let webStatus = "⏳ Iniciando...";
let webCode = "";
let qrTimeout = null;

// EQUIPOS ALERTA
const STAFF_VMA = ["56971350852@s.whatsapp.net", "56998251331@s.whatsapp.net"]; 
const STAFF_BODY = ["56983300262@s.whatsapp.net", "56955145504@s.whatsapp.net", "56937648536@s.whatsapp.net"];

// --- FUNCIÓN MAESTRA DE LIMPIEZA DE NÚMEROS ---
// Esta función elimina cualquier basura (+, espacios, ids raros) y deja solo el teléfono limpio
function limpiarNumero(jid) {
    if (!jid) return "";
    // 1. Quitamos dominios de WhatsApp
    let temp = jid.replace('@s.whatsapp.net', '').replace('@lid', '').split(':')[0];
    // 2. Dejamos SOLO dígitos numéricos (borra +, -, espacios)
    return temp.replace(/\D/g, ''); 
}

// --- ALERTAS ---
async function enviarAlerta(grupo, mensaje) {
    if (!sock) return;
    for (const numero of grupo) {
        try { await delay(2000); await sock.sendMessage(numero, { text: mensaje }); } catch (e) {}
    }
}

// --- REGISTRO UNIFICADO ---
function registrarChat(rawJid, nombre, mensaje, esBot = false) {
    try {
        let chats = {};
        if (fs.existsSync(CHAT_HISTORY_FILE)) chats = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8'));
        
        // APLICAMOS LA LIMPIEZA AQUÍ PARA UNIFICAR TODO
        const fonoUnico = limpiarNumero(rawJid);
        
        if (!chats[fonoUnico]) chats[fonoUnico] = { nombre, mensajes: [], unread: 0, lastTs: 0 };
        
        chats[fonoUnico].mensajes.push({ 
            hora: new Date().toLocaleTimeString('es-CL'), 
            texto: mensaje, 
            from: esBot ? 'Zara' : 'Cliente' 
        });
        chats[fonoUnico].lastTs = Date.now();
        if (!esBot) chats[fonoUnico].unread = (chats[fonoUnico].unread || 0) + 1;
        else chats[fonoUnico].unread = 0;
        
        if (chats[fonoUnico].mensajes.length > 60) chats[fonoUnico].mensajes.shift();
        fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(chats, null, 2));
        return true; 
    } catch (e) { return false; }
}

// --- CONEXIÓN WHATSAPP ---
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    
    sock = makeWASocket({ 
        auth: state, 
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        syncFullHistory: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000
    });

    if (!sock.authState.creds.registered) {
        webStatus = "🟡 ESPERANDO VINCULACIÓN";
        if (qrTimeout) clearTimeout(qrTimeout);
        qrTimeout = setTimeout(async () => {
            try {
                if (!sock.authState.creds.registered) {
                    const code = await sock.requestPairingCode(BOT_NUMBER);
                    webCode = code?.match(/.{1,4}/g)?.join("-");
                    webStatus = "🔑 CÓDIGO LISTO";
                }
            } catch (e) { webStatus = "⚠️ Error código (Espera 1 min)"; }
        }, 5000);
    }

    sock.ev.on("connection.update", (u) => {
        const { connection, lastDisconnect } = u;
        if (connection === "close") {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            webCode = "";
            if (statusCode === 401 || statusCode === DisconnectReason.loggedOut) {
                webStatus = "❌ SESIÓN ROTA (Ve a /reset)";
            } else {
                webStatus = `🔴 RECONECTANDO... (Code: ${statusCode})`;
                if (shouldReconnect) connectToWhatsApp();
            }
        } else if (connection === "open") {
            webStatus = "✅ ZARA ONLINE";
            webCode = "";
        }
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async ({ messages }) => {
        try {
            const msg = messages[0];
            if (!msg.message || msg.key.fromMe) return;
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
            if (text) {
                console.log(`📩 Msg: ${text.substring(0, 10)}...`);
                let realJid = msg.key.remoteJid;
                
                // Normalización extra por si acaso
                try { 
                    if (typeof jidNormalizedUser === 'function') {
                        const normalized = jidNormalizedUser(realJid);
                        if (normalized) realJid = normalized;
                    }
                } catch(e) {}

                // Extracción de nombre
                const nombre = msg.pushName || "Cliente";
                
                // REGISTRO CON LIMPIEZA
                const esNuevo = registrarChat(realJid, nombre, text, false);
                const fonoClean = limpiarNumero(realJid);

                if (esNuevo) await enviarAlerta(STAFF_VMA, `🔔 NUEVO: ${nombre} (+${fonoClean})`);

                try {
                    const response = await chatWithGPT(text, realJid);
                    await sock.sendMessage(msg.key.remoteJid, { text: response });
                    registrarChat(realJid, nombre, response, true);
                    
                    const botTxt = response.toLowerCase();
                    if (botTxt.includes("agendado") && botTxt.includes("body")) await enviarAlerta(STAFF_BODY, `📅 AGENDADO BODY: ${nombre} (+${fonoClean})`);
                    if (botTxt.includes("resumen final")) await enviarAlerta(STAFF_VMA, `✅ PEDIDO OK: ${nombre} (+${fonoClean})`);
                } catch (gptError) { console.error("Error IA:", gptError); }
            }
        } catch (e) { console.error("Upsert error:", e.message); }
    });
}

// --- RUTAS WEB ---
app.get('/estado', (req, res) => {
    res.send(`<html><head><meta http-equiv="refresh" content="3"><style>body{font-family:sans-serif;text-align:center;padding:50px;background:#f4f4f9}.card{background:white;padding:40px;border-radius:15px;box-shadow:0 4px 15px rgba(0,0,0,0.1);display:inline-block}.code{font-size:40px;background:#e8f5e9;padding:15px;margin:20px 0;color:#2e7d32;font-family:monospace;border:2px dashed green}.online{color:green}.offline{color:red}.btn{background:#c62828;color:white;padding:10px;text-decoration:none;border-radius:5px}</style></head><body><div class="card"><h1>🤖 Estado Zara</h1><h2 class="${webStatus.includes('ONLINE')?'online':'offline'}">${webStatus}</h2>${webCode?`<div class="code">${webCode}</div><p>Vincular en WhatsApp</p>`:''}${webStatus.includes('ROTA')?`<a href="/reset" class="btn">♻️ REINICIAR</a>`:''}</div></body></html>`);
});

app.get('/reset', (req, res) => {
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    res.send("<h1>♻️ Reiniciando...</h1><script>setTimeout(()=>window.location='/estado',5000)</script>");
    setTimeout(() => process.exit(0), 1000);
});

app.get('/monitor', (req, res) => {
    const auth = req.headers.authorization;
    if (!auth || Buffer.from(auth.split(' ')[1], 'base64').toString().split(':')[1] !== MONITOR_PASSWORD) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Monitor"');
        return res.status(401).send('Acceso denegado');
    }
    res.sendFile(path.join(__dirname, 'public/monitor.html'));
});

app.get('/api/history', (req, res) => { if (fs.existsSync(CHAT_HISTORY_FILE)) res.json(JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8'))); else res.json({}); });

app.get('/iniciar-envio', async (req, res) => {
    if (!sock) return res.send("Error: Bot desconectado");
    if (!fs.existsSync(CLIENTES_FILE)) return res.send("Error: Falta clientes.csv");
    const filas = fs.readFileSync(CLIENTES_FILE, 'utf-8').split('\n').filter(l => l.trim() !== "");
    res.write("Iniciando envio LENTO (20s)...\n");
    for (let i = 1; i < filas.length; i++) {
        const linea = filas[i];
        const [fono, nombre] = linea.split(',');
        
        // APLICAMOS LIMPIEZA TAMBIÉN AQUÍ
        const fonoClean = limpiarNumero(fono);
        
        if (fonoClean.length > 8) {
            const jid = fonoClean + "@s.whatsapp.net";
            const msg = `Hola ${nombre.trim()}, soy Camila de Uniformes VMA. Te escribo para enfrentar a tiempo al fantasma de marzo! ¿Te ayudo con los uniformes?`;
            try {
                await sock.sendMessage(jid, { text: msg });
                registrarChat(jid, nombre.trim(), msg, true);
                res.write(`✅ Enviado a ${nombre} (+${fonoClean})\n`);
                await delay(20000); 
            } catch (e) { res.write(`❌ Error ${nombre}: ${e.message}\n`); await delay(5000); }
        }
    }
    res.end("Campaña finalizada.");
});

app.listen(PORT, () => { console.log(`Puerto ${PORT}`); connectToWhatsApp(); });
