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

// --- DIRECTORIOS BLINDADOS ---
const BASE_DIR = "/data"; 
const STORAGE_ROOT = fs.existsSync(BASE_DIR) ? BASE_DIR : path.join(__dirname, "data");

const AUTH_DIR = path.join(STORAGE_ROOT, "auth_info_baileys");
const CHAT_HISTORY_FILE = path.join(STORAGE_ROOT, "historial_chats.json");
const BOT_STATE_FILE = path.join(STORAGE_ROOT, "bot_state.json");
const PROGRESS_FILE = path.join(STORAGE_ROOT, "progreso_campaña.json"); // <--- NUEVA MEMORIA
const CLIENTES_FILE = path.join(__dirname, "data/clientes.csv");

// Configurar número dinámico desde Render
const ZARA_NUMBER = process.env.NUMERO_WSP_A_VINCULAR || "56934424673"; 
const JUAN_CARLOS = "56937648536";
const TEAM_VMA = ["56998251331", "56971350852"];

const MENSAJES_CAMPAÑA = [
    "Hola {nombre} 👋, soy Camila de VMA. Te escribo para dejar listos tus uniformes hoy. Te recomiendo hacerlo pronto porque desde la segunda semana de febrero las filas son terribles 🏃💨. ¿Te ayudo a revisar tallas?",
    "¡Hola {nombre}! 🌟 Soy Camila de Uniformes VMA. Estamos avisando a los apoderados que es mejor ver lo del uniforme esta semana para evitar las filas de locos de febrero 🤯. ¿Quieres que veamos las opciones ahora?",
    "{nombre}, ¿cómo estás? Soy Camila de VMA 👋. Te escribo para ahorrarte el estrés de febrero con los uniformes. Estamos organizando la entrega del stock 2025. ¿Te gustaría dejarlo listo hoy? Avísame y te ayudo."
];

let sock;
let botActivo = false;
let stopSignal = false; // Bandera para pausar
let webStatus = "⏸️ MODO OBSERVADOR";
let dbClientes = {}; 
let envioStatus = { corriendo: false, actual: 0, total: 0, ultimoNombre: "Nadie", logs: [] };

function getChileTime() { return new Date().toLocaleString("es-CL", { timeZone: "America/Santiago", hour12: false }); }
function leerHistorialSeguro() { try { return JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8')); } catch { return {}; } }
function guardarHistorial(data) { fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(data, null, 2)); }
function getProgreso() { try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8')).index || 0; } catch { return 0; } }
function saveProgreso(i) { fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ index: i })); }
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
        if (!msg.message || msg.key.fromMe || !botActivo) return;
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

// --- GESTIÓN DE ENVÍO CON PAUSA ---
app.get('/iniciar-envio', async (req, res) => {
    if (!botActivo || !sock) return res.send("<h1>❌ ZARA OFFLINE</h1>");
    if (envioStatus.corriendo) return res.redirect('/progreso');
    
    stopSignal = false; // Quitar freno
    cargarBaseDatos(); 
    const lines = fs.readFileSync(CLIENTES_FILE, 'utf-8').split('\n').filter(l => l.includes(','));
    const startIndex = getProgreso(); // LEER DONDE QUEDÓ

    envioStatus = { corriendo: true, actual: startIndex, total: lines.length, ultimoNombre: "Reanudando...", logs: [] };
    res.redirect('/progreso');

    (async () => {
        // Bucle inteligente con índice
        for (let i = 0; i < lines.length; i++) {
            if (stopSignal || !botActivo) { 
                envioStatus.corriendo = false; 
                envioStatus.logs.unshift("⏸️ PAUSADO POR EL USUARIO");
                break; 
            }
            
            // SALTAR LOS YA ENVIADOS
            if (i < startIndex) continue;

            const line = lines[i];
            if (line.includes('telefono')) continue;
            const [phone, name] = line.split(',');
            if(!phone || !name) continue;

            const jid = phone.trim().replace('+','') + "@s.whatsapp.net";
            try {
                const msg = MENSAJES_CAMPAÑA[Math.floor(Math.random()*MENSAJES_CAMPAÑA.length)].replace("{nombre}", name.trim());
                await sock.sendMessage(jid, { text: msg });
                
                // Log y Guardar
                let chats = leerHistorialSeguro(); const fono = phone.trim().replace('+','');
                if (!chats[fono]) chats[fono] = { nombre: name.trim(), mensajes: [], firstAlertSent: false, tags: ['Campaña'], unread: 0 };
                chats[fono].mensajes.push({ hora: getChileTime(), texto: msg, from: 'Zara (Campaña)' });
                chats[fono].lastTs = Date.now();
                guardarHistorial(chats);
                
                envioStatus.logs.unshift(`✅ ${getChileTime()} - ${name.trim()}`);
                envioStatus.actual = i + 1; 
                envioStatus.ultimoNombre = name.trim();
                saveProgreso(i + 1); // GUARDA EL MARCADOR

                // Espera humana (3 a 5 min)
                await delay(Math.floor(Math.random() * (300000 - 180000 + 1)) + 180000);
            } catch (e) { envioStatus.logs.unshift(`❌ Error ${name.trim()}`); }
        } 
        envioStatus.corriendo = false;
    })();
});

app.get('/pausar', (req, res) => { stopSignal = true; res.redirect('/progreso'); }); // FRENO DE MANO
app.get('/reiniciar-lista', (req, res) => { saveProgreso(0); res.redirect('/'); }); // RESETEAR CONTADOR A 0

app.get('/progreso', (req, res) => { res.send(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="5"><title>🚀 DASHBOARD ENVÍO</title><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap" rel="stylesheet"><style>body{font-family:'Inter',sans-serif;background:#111b21;color:white;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}.card{background:#202c33;padding:30px;border-radius:15px;box-shadow:0 4px 15px rgba(0,0,0,0.5);width:500px;text-align:center}.progress-bar{background:#374045;border-radius:10px;height:20px;overflow:hidden;margin:20px 0}.fill{background:#00a884;height:100%;width:${(envioStatus.actual/envioStatus.total)*100}%}.log-box{background:#0b141a;color:#0f0;font-family:monospace;text-align:left;padding:10px;height:200px;overflow-y:auto;border-radius:5px;font-size:0.85rem}h1{color:#00a884;margin-bottom:5px}.btn{padding:10px 20px;border-radius:5px;cursor:pointer;font-weight:bold;text-decoration:none;border:none;margin:5px}.btn-red{background:#e53935;color:white}.btn-green{background:#00a884;color:white}.data-row{display:flex;justify-content:space-between;margin-bottom:10px;font-size:0.9rem;color:#aebac1}</style></head><body><div class="card"><h1>🚀 CAMPAÑA EN CURSO</h1><div class="progress-bar"><div class="fill"></div></div><div class="data-row"><span>📨 Progreso: <b>${envioStatus.actual} / ${envioStatus.total}</b></span><span>⏱ Intervalo: <b>3 - 5 min</b></span></div><div class="data-row"><span>👤 Último: <b>${envioStatus.ultimoNombre}</b></span><span>🟢 Estado: <b>${envioStatus.corriendo?"ENVIANDO...":"PAUSADO"}</b></span></div><div class="log-box">${envioStatus.logs.join("<br>")}</div><br>${envioStatus.corriendo ? '<a href="/pausar"><button class="btn btn-red">⏸ PAUSAR AHORA</button></a>' : '<a href="/iniciar-envio"><button class="btn btn-green">▶️ REANUDAR</button></a>'}<a href="/monitor"><button class="btn" style="background:#027eb5;color:white">📺 IR AL MONITOR</button></a></div></body></html>`); });

app.get('/api/status-envio', (req, res) => { res.json(envioStatus); });
app.get('/monitor', (req, res) => res.sendFile(path.join(__dirname, 'public/monitor.html')));
app.get('/historial-chats', (req, res) => { res.json(leerHistorialSeguro()); });
app.post('/api/send-manual', async (req, res) => { const { fono, texto } = req.body; if (botActivo && sock) { await sock.sendMessage(fono+"@s.whatsapp.net", { text: texto }); let c=leerHistorialSeguro(); if(c[fono]){ c[fono].mensajes.push({ hora: getChileTime(), texto: texto, from: 'Zara (Manual)' }); guardarHistorial(c); } res.json({success:true}); } });
app.post('/api/tag', (req, res) => { const { fono, tag } = req.body; let c = leerHistorialSeguro(); if(c[fono]) { if(!c[fono].tags) c[fono].tags=[]; if(!c[fono].tags.includes(tag)) c[fono].tags.push(tag); guardarHistorial(c); } res.json({success:true}); });
app.post('/api/read', (req, res) => { const { fono } = req.body; let c = leerHistorialSeguro(); if(c[fono]) { c[fono].unread=0; guardarHistorial(c); } res.json({success:true}); });
app.listen(PORT, () => { console.log("SERVER V4: PAUSE & RESUME READY"); cargarBaseDatos(); cargarEstadoBot(); });
