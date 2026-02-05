// SERVER V7: AUTO-TAGGING INTELLIGENCE
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
const BASE_DIR = "/data"; 
const STORAGE_ROOT = fs.existsSync(BASE_DIR) ? BASE_DIR : path.join(__dirname, "data");
const AUTH_DIR = path.join(STORAGE_ROOT, "auth_info_baileys");
const CHAT_HISTORY_FILE = path.join(STORAGE_ROOT, "historial_chats.json");
const BOT_STATE_FILE = path.join(STORAGE_ROOT, "bot_state.json");
const PROGRESS_FILE = path.join(STORAGE_ROOT, "progreso_campaña.json");
const CLIENTES_FILE = path.join(__dirname, "data/clientes.csv");

const TEAM_VMA = ["56998251331", "56971350852"];
const JUAN_CARLOS = "56937648536";

// PALABRAS GATILLO PARA ETIQUETADO AUTOMÁTICO
const KEYWORDS_BODY = ["body", "elite", "clínica", "clinica", "escáner", "escaner", "lipo", "facial", "antiage", "evaluación", "evaluacion", "alianza", "regalo"];
const KEYWORDS_VMA = ["talla", "uniforme", "polera", "falda", "pantalon", "buzo", "colegio", "mayor", "stock", "precio"];

const MENSAJES_CAMPAÑA = [
    "Hola {nombre} 👋, soy Camila de VMA. Te escribo para dejar listos tus uniformes hoy... ¿Te ayudo?",
    "¡Hola {nombre}! 🌟 Soy Camila de Uniformes VMA. Estamos avisando para evitar filas... ¿Vemos opciones?",
    "{nombre}, ¿cómo estás? Soy Camila de VMA 👋. Te escribo para ahorrarte estrés... ¿Te ayudo?"
];

let sock;
let botActivo = false;
let stopSignal = false;
let webStatus = "ESPERANDO...";
let qrCode = null; 
let dbClientes = {}; 
let envioStatus = { corriendo: false, actual: 0, total: 0, ultimoNombre: "Nadie", logs: [] };

function getChileTime() { return new Date().toLocaleString("es-CL", { timeZone: "America/Santiago", hour12: false }); }
function cleanNumber(id) { return id.replace(/\D/g, ''); }
function leerHistorialSeguro() { try { return JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8')); } catch { return {}; } }
function guardarHistorial(data) { fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(data, null, 2)); }
function getProgreso() { try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8')).index || 0; } catch { return 0; } }
function saveProgreso(i) { fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ index: i })); }
function cargarBaseDatos() { try { if (fs.existsSync(CLIENTES_FILE)) { fs.readFileSync(CLIENTES_FILE, 'utf-8').split('\n').forEach(l => { const p = l.split(','); if(p.length>=2) dbClientes[cleanNumber(p[0])] = p[1].trim(); }); } } catch (e) {} }
function cargarEstadoBot() { try { if (fs.existsSync(BOT_STATE_FILE)) { const s = JSON.parse(fs.readFileSync(BOT_STATE_FILE, 'utf-8')); if(s.active) { botActivo=true; connectToWhatsApp(); } } } catch(e){} }

// LÓGICA DE AUTO-ETIQUETADO
function autoTag(chat, text) {
    if (!chat.tags) chat.tags = [];
    const lower = text.toLowerCase();
    
    // Si habla de cosas de clínica, agregar tag BodyElite
    if (KEYWORDS_BODY.some(k => lower.includes(k))) {
        if (!chat.tags.includes('BodyElite')) chat.tags.push('BodyElite');
    }
    // Si habla de uniformes, asegurar tag VMA
    if (KEYWORDS_VMA.some(k => lower.includes(k))) {
        if (!chat.tags.includes('VMA')) chat.tags.push('VMA');
    }
    return chat;
}

async function connectToWhatsApp() {
    if (!botActivo) return;
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    sock = makeWASocket({ auth: state, logger: pino({ level: "silent" }), browser: ["ZaraVMA", "Chrome", "1.0.0"], printQRInTerminal: false });
    
    sock.ev.on("connection.update", (u) => {
        const { connection, lastDisconnect, qr } = u;
        if (qr) { qrCode = qr; webStatus = "QR"; }
        if (connection === "open") { webStatus = "✅ ZARA ONLINE"; qrCode = null; }
        if (connection === "close") { 
            if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut && botActivo) connectToWhatsApp(); 
            else { botActivo = false; webStatus = "❌ Desconectado"; qrCode = null; } 
        }
    });
    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe || !botActivo) return;
        const jid = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        
        if (text) {
            const fono = cleanNumber(jid);
            const nombrePush = dbClientes[fono] || msg.pushName || "Cliente";
            
            let chats = leerHistorialSeguro();
            // INICIALIZACIÓN
            if (!chats[fono]) chats[fono] = { nombre: nombrePush, mensajes: [], firstAlertSent: false, tags: ['VMA'], unread: 0 };
            
            // AUTO-TAGGING AL RECIBIR MENSAJE
            chats[fono] = autoTag(chats[fono], text);

            chats[fono].mensajes.push({ hora: getChileTime(), texto: text, from: 'Cliente' });
            chats[fono].lastTs = Date.now();
            chats[fono].unread = (chats[fono].unread || 0) + 1;
            
            if (!chats[fono].firstAlertSent) {
                const alerta = `🔔 *LEAD*\n👤 ${nombrePush}\n📱 +${fono}\n💬 "${text}"`;
                for(const s of [...TEAM_VMA, JUAN_CARLOS]) await sock.sendMessage(s+"@s.whatsapp.net", {text: alerta});
                chats[fono].firstAlertSent = true;
            }
            guardarHistorial(chats);
            
            await delay(3000 + Math.random() * 2000);
            const response = await chatWithGPT(text, fono);
            
            // AUTO-TAGGING TAMBIÉN EN LA RESPUESTA DEL BOT (Si el bot ofrece la clínica, se etiqueta)
            chats[fono] = autoTag(chats[fono], response);
            
            await sock.sendMessage(jid, { text: response });
            chats[fono].mensajes.push({ hora: getChileTime(), texto: response, from: 'Zara' });
            guardarHistorial(chats);
        }
    });
}

// ENDPOINTS
app.get('/reset', (req, res) => { botActivo = false; qrCode = null; try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); res.send("RESET OK"); } catch(e) { res.send(e.message); } });
app.get('/encender-zara', (req, res) => { botActivo = true; fs.writeFileSync(BOT_STATE_FILE, JSON.stringify({ active: true })); connectToWhatsApp(); res.redirect('/'); });
app.get('/estado', async (req, res) => { if (qrCode) res.json({ status: "QR", qr: qrCode }); else res.json({ status: webStatus }); });

app.get('/iniciar-envio', async (req, res) => {
    if (!botActivo || !sock) return res.send("<h1>❌ ZARA OFFLINE</h1>");
    if (envioStatus.corriendo) return res.redirect('/progreso');
    stopSignal = false; cargarBaseDatos(); 
    const lines = fs.readFileSync(CLIENTES_FILE, 'utf-8').split('\n').filter(l => l.includes(','));
    const startIndex = getProgreso(); 
    envioStatus = { corriendo: true, actual: startIndex, total: lines.length, ultimoNombre: "Reanudando...", logs: [] };
    res.redirect('/progreso');
    (async () => {
        for (let i = 0; i < lines.length; i++) {
            if (stopSignal || !botActivo) { envioStatus.corriendo = false; envioStatus.logs.unshift("⏸️ PAUSADO"); break; }
            if (i < startIndex) continue;
            const line = lines[i]; if (line.includes('telefono')) continue;
            const [phone, name] = line.split(','); if(!phone || !name) continue;
            
            const cleanPhone = cleanNumber(phone);
            const jid = cleanPhone + "@s.whatsapp.net";
            
            try {
                const msg = MENSAJES_CAMPAÑA[Math.floor(Math.random()*MENSAJES_CAMPAÑA.length)].replace("{nombre}", name.trim());
                await sock.sendMessage(jid, { text: msg });
                
                let chats = leerHistorialSeguro(); 
                if (!chats[cleanPhone]) chats[cleanPhone] = { nombre: name.trim(), mensajes: [], firstAlertSent: false, tags: ['Campaña', 'VMA'], unread: 0 };
                
                chats[cleanPhone].mensajes.push({ hora: getChileTime(), texto: msg, from: 'Zara (Campaña)' });
                chats[cleanPhone].lastTs = Date.now(); 
                guardarHistorial(chats);
                
                envioStatus.logs.unshift(`✅ ${getChileTime()} - ${name.trim()}`);
                envioStatus.actual = i + 1; envioStatus.ultimoNombre = name.trim(); saveProgreso(i + 1); 
                await delay(Math.floor(Math.random() * (300000 - 180000 + 1)) + 180000);
            } catch (e) { envioStatus.logs.unshift(`❌ Error ${name.trim()}`); }
        } envioStatus.corriendo = false;
    })();
});

app.get('/pausar', (req, res) => { stopSignal = true; res.redirect('/progreso'); });
app.get('/reiniciar-lista', (req, res) => { saveProgreso(0); res.redirect('/'); });
app.get('/progreso', (req, res) => { res.send(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="5"><title>🚀 ENVÍO</title><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap" rel="stylesheet"><style>body{font-family:'Inter',sans-serif;background:#111b21;color:white;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}.card{background:#202c33;padding:30px;border-radius:15px;width:500px;text-align:center}.progress-bar{background:#374045;border-radius:10px;height:20px;overflow:hidden;margin:20px 0}.fill{background:#00a884;height:100%;width:${(envioStatus.actual/envioStatus.total)*100}%}.log-box{background:#0b141a;color:#0f0;font-family:monospace;text-align:left;padding:10px;height:200px;overflow-y:auto;border-radius:5px;font-size:0.85rem}h1{color:#00a884;margin-bottom:5px}.btn{padding:10px 20px;border-radius:5px;cursor:pointer;font-weight:bold;text-decoration:none;border:none;margin:5px}.btn-red{background:#e53935;color:white}.btn-green{background:#00a884;color:white}</style></head><body><div class="card"><h1>🚀 CAMPAÑA</h1><div class="progress-bar"><div class="fill"></div></div><p>Progreso: <b>${envioStatus.actual} / ${envioStatus.total}</b> | Último: <b>${envioStatus.ultimoNombre}</b></p><div class="log-box">${envioStatus.logs.join("<br>")}</div><br>${envioStatus.corriendo ? '<a href="/pausar"><button class="btn btn-red">⏸ PAUSAR</button></a>' : '<a href="/iniciar-envio"><button class="btn btn-green">▶️ REANUDAR</button></a>'}<a href="/monitor"><button class="btn" style="background:#027eb5;color:white">📺 MONITOR</button></a></div></body></html>`); });
app.get('/api/status-envio', (req, res) => { res.json(envioStatus); });
app.get('/monitor', (req, res) => res.sendFile(path.join(__dirname, 'public/monitor.html')));
app.get('/historial-chats', (req, res) => { res.json(leerHistorialSeguro()); });
app.post('/api/send-manual', async (req, res) => { const { fono, texto } = req.body; const clean = cleanNumber(fono); if (botActivo && sock) { await sock.sendMessage(clean+"@s.whatsapp.net", { text: texto }); let c=leerHistorialSeguro(); if(c[clean]){ c[clean].mensajes.push({ hora: getChileTime(), texto: texto, from: 'Zara (Manual)' }); guardarHistorial(c); } res.json({success:true}); } });
app.post('/api/tag', (req, res) => { const { fono, tag } = req.body; let c = leerHistorialSeguro(); if(c[fono]) { if(!c[fono].tags) c[fono].tags=[]; if(!c[fono].tags.includes(tag)) c[fono].tags.push(tag); guardarHistorial(c); } res.json({success:true}); });
app.post('/api/read', (req, res) => { const { fono } = req.body; let c = leerHistorialSeguro(); if(c[fono]) { c[fono].unread=0; guardarHistorial(c); } res.json({success:true}); });
app.listen(PORT, () => { console.log("SERVER V7: AUTO-TAGGING ON"); cargarBaseDatos(); cargarEstadoBot(); });
