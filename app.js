const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require("@whiskeysockets/baileys");
const pino = require("pino");
const express = require("express");
const fs = require("fs");
const path = require("path");
const { chatWithGPT } = require("./services/chatgpt");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// --- CONFIGURACIÓN DE DISCO DURO (/data) ---
const BASE_DIR = "/data"; 
const STORAGE_ROOT = fs.existsSync(BASE_DIR) ? BASE_DIR : path.join(__dirname, "data");

const AUTH_DIR = path.join(STORAGE_ROOT, "auth_info_baileys");
const CHAT_HISTORY_FILE = path.join(STORAGE_ROOT, "historial_chats.json");
const BOT_STATE_FILE = path.join(STORAGE_ROOT, "bot_state.json");
const CLIENTES_FILE = path.join(__dirname, "data/clientes.csv");

// --- FUNCIÓN DE AUTO-RECUPERACIÓN ---
function leerHistorialSeguro() { 
    try {
        if (fs.existsSync(CHAT_HISTORY_FILE)) {
            return JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8'));
        }
        if (fs.existsSync(BASE_DIR)) {
            const files = fs.readdirSync(BASE_DIR);
            const backups = files.filter(f => f.endsWith('.json') && !f.includes('bot_state') && !f.includes('auth'));
            if (backups.length > 0) {
                backups.sort((a, b) => fs.statSync(path.join(BASE_DIR, b)).size - fs.statSync(path.join(BASE_DIR, a)).size);
                const mejorRespaldo = backups[0];
                console.log(`✅ RESPALDO ENCONTRADO: ${mejorRespaldo}`);
                const data = JSON.parse(fs.readFileSync(path.join(BASE_DIR, mejorRespaldo), 'utf-8'));
                fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(data, null, 2));
                return data;
            }
        }
    } catch (e) { console.error("Error recuperando DB:", e); }
    return {}; 
}

function guardarHistorial(data) { fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(data, null, 2)); }
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

// --- CONFIGURACIÓN STANDARD ---
const ZARA_NUMBER = "56934424673"; 
const JUAN_CARLOS = "56937648536";
const TEAM_VMA = ["56998251331", "56971350852"];
const MENSAJES_CAMPAÑA = [
    "Hola {nombre} 👋, soy Camila de VMA. Te escribo para dejar listos tus uniformes hoy. Te recomiendo hacerlo pronto porque desde la segunda semana de febrero las filas son terribles 🏃💨. ¿Te ayudo a revisar tallas?",
    "¡Hola {nombre}! 🌟 Soy Camila de Uniformes VMA. Estamos avisando a los apoderados que es mejor ver lo del uniforme esta semana para evitar las filas de locos de febrero 🤯. ¿Quieres que veamos las opciones ahora?",
    "{nombre}, ¿cómo estás? Soy Camila de VMA 👋. Te escribo para ahorrarte el estrés de febrero con los uniformes. Estamos organizando la entrega del stock 2025. ¿Te gustaría dejarlo listo hoy? Avísame y te ayudo."
];

let sock;
let botActivo = false;
let webStatus = "⏸️ MODO OBSERVADOR";
let dbClientes = {}; 
let envioStatus = { corriendo: false, actual: 0, total: 0, ultimoNombre: "Nadie", logs: [] };

function getChileTime() { return new Date().toLocaleString("es-CL", { timeZone: "America/Santiago", hour12: false }); }
function cargarBaseDatos() { try { if (fs.existsSync(CLIENTES_FILE)) { fs.readFileSync(CLIENTES_FILE, 'utf-8').split('\n').forEach(l => { const p = l.split(','); if(p.length>=2) dbClientes[p[0].trim().replace(/\D/g,'')] = p[1].trim(); }); } } catch (e) {} }
function cargarEstadoBot() { try { if (fs.existsSync(BOT_STATE_FILE)) { const s = JSON.parse(fs.readFileSync(BOT_STATE_FILE, 'utf-8')); if(s.active) { botActivo=true; connectToWhatsApp(); } } } catch(e){} }

async function connectToWhatsApp() {
    if (!botActivo) return;
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    sock = makeWASocket({ auth: state, logger: pino({ level: "silent" }), browser: ["ZaraVMA", "Chrome", "1.0.0"], printQRInTerminal: false });
    sock.ev.on("connection.update", (u) => {
        const { connection, lastDisconnect } = u;
        if (connection === "open") webStatus = "✅ ZARA ONLINE";
        if (connection === "close") { 
            if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut && botActivo) connectToWhatsApp(); 
            else { botActivo = false; webStatus = "❌ Desconectado"; } 
        }
    });
    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return; 
        if (!botActivo) return;
        const jid = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (text) {
            const fono = jid.split('@')[0].replace(/\D/g, '');
            const nombrePush = dbClientes[fono] || msg.pushName || "Cliente";
            let chats = leerHistorialSeguro();
            if (!chats[fono]) chats[fono] = { nombre: nombrePush, mensajes: [], firstAlertSent: false, tags: [], unread: 0 };
            chats[fono].mensajes.push({ hora: getChileTime(), texto: text, from: 'Cliente' });
            chats[fono].lastTs = Date.now();
            chats[fono].unread = (chats[fono].unread || 0) + 1;
            if (!chats[fono].firstAlertSent) {
                const alerta = `🔔 *NUEVO LEAD*\n👤 ${nombrePush}\n📱 +${fono}\n💬 "${text}"`;
                for(const s of [...TEAM_VMA, JUAN_CARLOS]) await sock.sendMessage(s+"@s.whatsapp.net", {text: alerta});
                chats[fono].firstAlertSent = true;
            }
            guardarHistorial(chats);
            await delay(3000 + Math.random() * 2000);
            const response = await chatWithGPT(text, fono);
            await sock.sendMessage(jid, { text: response });
            chats[fono].mensajes.push({ hora: getChileTime(), texto: response, from: 'Zara' });
            guardarHistorial(chats);
        }
    });
}

// ENDPOINTS
app.get('/reset', (req, res) => { botActivo = false; try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); res.send("RESET OK"); } catch(e) { res.send(e.message); } });
app.get('/encender-zara', (req, res) => { botActivo = true; fs.writeFileSync(BOT_STATE_FILE, JSON.stringify({ active: true })); connectToWhatsApp(); res.redirect('/'); });
app.get('/estado', async (req, res) => { try { if (botActivo && sock && !sock.authState.creds.registered) { const code = await sock.requestPairingCode(ZARA_NUMBER); res.json({ status: "PAIRING", code: code }); } else { res.json({ status: webStatus }); } } catch(e) { res.json({ status: "ERROR", msg: e.message }); } });
app.get('/iniciar-envio', async (req, res) => {
    if (!botActivo || !sock) return res.send("<h1>❌ ZARA OFFLINE</h1>");
    if (envioStatus.corriendo) return res.redirect('/');
    cargarBaseDatos(); const lines = fs.readFileSync(CLIENTES_FILE, 'utf-8').split('\n').filter(l => l.includes(','));
    envioStatus = { corriendo: true, actual: 0, total: lines.length, ultimoNombre: "Iniciando...", logs: [] };
    res.redirect('/');
    (async () => {
        let count = 0;
        for (const line of lines) {
            if (!botActivo) { envioStatus.corriendo = false; break; }
            if (line.includes('telefono')) continue;
            const [phone, name] = line.split(',');
            if(!phone || !name) continue;
            const jid = phone.trim().replace('+','') + "@s.whatsapp.net";
            try {
                const msg = MENSAJES_CAMPAÑA[Math.floor(Math.random()*MENSAJES_CAMPAÑA.length)].replace("{nombre}", name.trim());
                await sock.sendMessage(jid, { text: msg });
                let chats = leerHistorialSeguro(); const fono = phone.trim().replace('+','');
                if (!chats[fono]) chats[fono] = { nombre: name.trim(), mensajes: [], firstAlertSent: false, tags: ['Campaña'], unread: 0 };
                chats[fono].mensajes.push({ hora: getChileTime(), texto: msg, from: 'Zara (Campaña)' });
                chats[fono].lastTs = Date.now();
                guardarHistorial(chats);
                envioStatus.logs.unshift(`✅ ${getChileTime()} - ${name.trim()}`);
                count++; envioStatus.actual = count; envioStatus.ultimoNombre = name.trim();
                await delay(Math.floor(Math.random() * (300000 - 180000 + 1)) + 180000);
            } catch (e) { envioStatus.logs.unshift(`❌ Error ${name.trim()}`); }
        } envioStatus.corriendo = false;
    })();
});
app.get('/api/status-envio', (req, res) => { res.json(envioStatus); });
app.get('/monitor', (req, res) => res.sendFile(path.join(__dirname, 'public/monitor.html')));
app.get('/historial-chats', (req, res) => { res.json(leerHistorialSeguro()); });
app.post('/api/send-manual', async (req, res) => { const { fono, texto } = req.body; if (botActivo && sock) { await sock.sendMessage(fono+"@s.whatsapp.net", { text: texto }); let c=leerHistorialSeguro(); if(c[fono]){ c[fono].mensajes.push({ hora: getChileTime(), texto: texto, from: 'Zara (Manual)' }); guardarHistorial(c); } res.json({success:true}); } });
app.post('/api/tag', (req, res) => { const { fono, tag } = req.body; let c = leerHistorialSeguro(); if(c[fono]) { if(!c[fono].tags) c[fono].tags=[]; if(!c[fono].tags.includes(tag)) c[fono].tags.push(tag); guardarHistorial(c); } res.json({success:true}); });
app.post('/api/read', (req, res) => { const { fono } = req.body; let c = leerHistorialSeguro(); if(c[fono]) { c[fono].unread=0; guardarHistorial(c); } res.json({success:true}); });

app.listen(PORT, () => { console.log("SERVER FINAL V3 (PERSISTENTE)"); cargarBaseDatos(); cargarEstadoBot(); });
