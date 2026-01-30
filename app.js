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

// --- CONFIGURACIÓN CONSTANTE ---
const PORT = process.env.PORT || 3000;
const MONITOR_PASSWORD = process.env.MONITOR_PASSWORD || "123456";
const CHAT_HISTORY_FILE = "/data/historial_chats.json";
const CLIENTES_FILE = path.join(__dirname, "data", "clientes.csv");
const AUTH_DIR = "/data/auth_info_baileys";
const BOT_NUMBER = "56934424673"; 

// --- ESTADO GLOBAL ---
let sock;
let webStatus = "⏳ Iniciando servidor...";
let webCode = "";
let qrTimeout = null;

// EQUIPOS ALERTA
const STAFF_VMA = ["56971350852@s.whatsapp.net", "56998251331@s.whatsapp.net"]; 
const STAFF_BODY = ["56983300262@s.whatsapp.net", "56955145504@s.whatsapp.net", "56937648536@s.whatsapp.net"];

// --- FUNCIONES AUXILIARES ---
async function enviarAlerta(grupo, mensaje) {
    if (!sock) return;
    for (const numero of grupo) {
        try { await delay(2000); await sock.sendMessage(numero, { text: mensaje }); } catch (e) {}
    }
}

function registrarChat(jid, nombre, mensaje, esBot = false) {
    try {
        let chats = {};
        if (fs.existsSync(CHAT_HISTORY_FILE)) chats = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8'));
        const fonoLimpio = jid.replace('@s.whatsapp.net', '').replace('@lid', '').split(':')[0];
        if (!chats[fonoLimpio]) chats[fonoLimpio] = { nombre, mensajes: [], unread: 0, lastTs: 0 };
        chats[fonoLimpio].mensajes.push({ hora: new Date().toLocaleTimeString('es-CL'), texto: mensaje, from: esBot ? 'Zara' : 'Cliente' });
        chats[fonoLimpio].lastTs = Date.now();
        if (!esBot) chats[fonoLimpio].unread = (chats[fonoLimpio].unread || 0) + 1;
        else chats[fonoLimpio].unread = 0;
        if (chats[fonoLimpio].mensajes.length > 60) chats[fonoLimpio].mensajes.shift();
        fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(chats, null, 2));
        return true; 
    } catch (e) { return false; }
}

// --- LÓGICA DE CONEXIÓN ---
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    
    sock = makeWASocket({ 
        auth: state, 
        printQRInTerminal: false, // Usamos la web para el código
        logger: pino({ level: "silent" }),
        browser: ["Ubuntu", "Chrome", "20.0.04"], // ESTÁNDAR FIJO
        syncFullHistory: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000
    });

    // Manejo de Código de Vinculación
    if (!sock.authState.creds.registered) {
        webStatus = "🟡 ESPERANDO VINCULACIÓN";
        
        // Esperamos 5 segundos para asegurar que el socket esté listo
        if (qrTimeout) clearTimeout(qrTimeout);
        qrTimeout = setTimeout(async () => {
            try {
                if (!sock.authState.creds.registered) {
                    console.log("Solicitando código...");
                    const code = await sock.requestPairingCode(BOT_NUMBER);
                    webCode = code?.match(/.{1,4}/g)?.join("-");
                    webStatus = "🔑 CÓDIGO LISTO - VINCULA AHORA";
                    console.log("CÓDIGO GENERADO: " + webCode);
                }
            } catch (e) {
                console.error("Error pidiendo código:", e.message);
                webStatus = "⚠️ Error generando código. Espera reinicio...";
            }
        }, 5000);
    }

    sock.ev.on("connection.update", (u) => {
        const { connection, lastDisconnect } = u;
        if (connection === "close") {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            webCode = ""; // Limpiamos código al desconectar
            
            if (statusCode === 401 || statusCode === DisconnectReason.loggedOut) {
                webStatus = "❌ SESIÓN CADUCADA (Error 401). REQUIERE RESET.";
                console.log("Credenciales inválidas. Esperando acción manual en /reset");
                // NO REINICIAMOS AUTOMÁTICAMENTE PARA EVITAR BUCLES
            } else {
                webStatus = `🔴 DESCONECTADO (Code: ${statusCode}). Reconectando...`;
                console.log(webStatus);
                if (shouldReconnect) connectToWhatsApp();
            }
        } else if (connection === "open") {
            webStatus = "✅ ZARA ONLINE - CONECTADO Y ESTABLE";
            webCode = "";
            console.log(webStatus);
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
                try { if (typeof jidNormalizedUser === 'function') realJid = jidNormalizedUser(msg.key.remoteJid); } catch(e) {}
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
                    if (botTxt.includes("agendado") && botTxt.includes("body")) await enviarAlerta(STAFF_BODY, `📅 AGENDADO BODY: ${nombre} (+${fono})`);
                    if (botTxt.includes("resumen final")) await enviarAlerta(STAFF_VMA, `✅ PEDIDO OK: ${nombre} (+${fono})`);
                } catch (gptError) { console.error("Error IA:", gptError); }
            }
        } catch (e) { console.error("Upsert error:", e.message); }
    });
}

// --- RUTAS WEB ---

// 1. ESTADO DEL BOT
app.get('/estado', (req, res) => {
    res.send(`
    <html>
        <head>
            <title>Estado Zara</title>
            <meta http-equiv="refresh" content="3">
            <style>
                body { font-family: sans-serif; text-align: center; padding: 50px; background: #f4f4f9; }
                .card { background: white; padding: 40px; border-radius: 15px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); display: inline-block; max-width: 500px; }
                .code { font-size: 42px; font-family: monospace; letter-spacing: 3px; background: #e8f5e9; padding: 15px; border-radius: 8px; margin: 25px 0; color: #2e7d32; border: 2px dashed #2e7d32; }
                .status { font-size: 22px; font-weight: bold; margin-bottom: 20px; }
                .online { color: #2e7d32; } .offline { color: #c62828; } .waiting { color: #f57f17; }
                .btn { display: inline-block; padding: 10px 20px; margin-top: 20px; background: #c62828; color: white; text-decoration: none; border-radius: 5px; font-weight: bold; }
                .btn:hover { background: #b71c1c; }
            </style>
        </head>
        <body>
            <div class="card">
                <h1>🤖 Panel de Control Zara</h1>
                <p class="status ${webStatus.includes('ONLINE') ? 'online' : (webStatus.includes('CÓDIGO') ? 'waiting' : 'offline')}">${webStatus}</p>
                
                ${webCode ? `
                    <p>Tu código de vinculación es:</p>
                    <div class="code">${webCode}</div>
                    <p><small>WhatsApp > Dispositivos > Vincular</small></p>
                ` : ''}
                
                ${webStatus.includes('401') ? `
                    <p>⚠️ La sesión está rota.</p>
                    <a href="/reset" class="btn">♻️ BORRAR SESIÓN Y REINICIAR</a>
                ` : ''}

                ${webStatus.includes('ONLINE') ? '<p>🚀 El sistema opera normalmente.</p>' : ''}
            </div>
        </body>
    </html>
    `);
});

// 2. REINICIO MANUAL (BOTÓN DE PÁNICO)
app.get('/reset', (req, res) => {
    try {
        console.log("♻️ EJECUTANDO RESET MANUAL...");
        if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        }
        res.send("<h1>♻️ Sistema Reiniciado</h1><p>Borrando credenciales y reiniciando... Vuelve a <a href='/estado'>/estado</a> en 10 segundos.</p>");
        setTimeout(() => process.exit(0), 1000); // Reinicio controlado
    } catch (e) {
        res.send("Error al reiniciar: " + e.message);
    }
});

// 3. MONITOR CRM
app.get('/monitor', (req, res) => {
    const auth = req.headers.authorization;
    if (!auth || Buffer.from(auth.split(' ')[1], 'base64').toString().split(':')[1] !== MONITOR_PASSWORD) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Monitor"');
        return res.status(401).send('Acceso denegado');
    }
    res.sendFile(path.join(__dirname, 'public/monitor.html'));
});

app.get('/api/history', (req, res) => { if (fs.existsSync(CHAT_HISTORY_FILE)) res.json(JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8'))); else res.json({}); });

// 4. ENVÍO CAMPAÑA
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
                res.write(`✅ Enviado a ${nombre}\n`);
                await delay(20000); 
            } catch (e) { res.write(`❌ Error ${nombre}: ${e.message}\n`); await delay(5000); }
        }
    }
    res.end("Campaña finalizada.");
});

app.listen(PORT, () => { 
    console.log(`Puerto ${PORT}`); 
    connectToWhatsApp(); 
});
