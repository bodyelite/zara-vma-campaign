const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay, jidNormalizedUser } = require("@whiskeysockets/baileys");
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
const CHAT_HISTORY_FILE = "/data/historial_chats.json";
const CLIENTES_FILE = path.join(__dirname, "data", "clientes.csv");
const AUTH_DIR = "/data/auth_info_baileys";
const BOT_NUMBER = "56934424673";

let sock;
let webStatus = "⏳ Iniciando...";
let webCode = "";
let clientesMap = [];
let messageBuffer = {}; 

function cargarMapaClientes() {
    try {
        if (fs.existsSync(CLIENTES_FILE)) {
            const filas = fs.readFileSync(CLIENTES_FILE, 'utf-8').split('\n').filter(l => l.trim() !== "");
            clientesMap = filas.map(l => {
                const [f, n] = l.split(',');
                return { fono: f.replace(/\D/g, ''), nombre: n ? n.trim() : 'Sin Nombre' };
            });
        }
    } catch (e) {}
}

const STAFF_VMA = ["56971350852@s.whatsapp.net", "56998251331@s.whatsapp.net", "56937648536@s.whatsapp.net", "218120098701428@s.whatsapp.net"];
const STAFF_BODY = ["56983300262@s.whatsapp.net", "56955145504@s.whatsapp.net", "56937648536@s.whatsapp.net", "218120098701428@s.whatsapp.net"];

async function enviarAlerta(grupo, mensaje) {
    if (!sock) return;
    for (const d of grupo) { try { await delay(2000); await sock.sendMessage(d, { text: mensaje }); } catch (e) {} }
}

function registrarChat(fono, nombre, mensaje, tag = null, esBot = false) {
    try {
        let chats = fs.existsSync(CHAT_HISTORY_FILE) ? JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8')) : {};
        if (!chats[fono]) chats[fono] = { nombre, mensajes: [], unread: 0, lastTs: 0, tags: [] };
        if (tag && !chats[fono].tags.includes(tag)) chats[fono].tags.push(tag);
        chats[fono].mensajes.push({ hora: new Date().toLocaleTimeString('es-CL'), texto: mensaje, from: esBot ? 'Zara' : 'Cliente' });
        chats[fono].lastTs = Date.now();
        if (!esBot) chats[fono].unread++; else chats[fono].unread = 0;
        if (chats[fono].mensajes.length > 50) chats[fono].mensajes.shift();
        fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(chats, null, 2));
        return chats[fono].mensajes.length === 1;
    } catch (e) { return false; }
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    sock = makeWASocket({ auth: state, logger: pino({ level: "silent" }), browser: ["Ubuntu", "Chrome", "20.0.04"] });

    sock.ev.on("connection.update", (u) => {
        const { connection, lastDisconnect } = u;
        if (connection === "close") {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === "open") { 
            webStatus = "✅ ZARA ONLINE"; 
            webCode = ""; 
        }
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const jid = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;

        if (text) {
            if (!messageBuffer[jid]) messageBuffer[jid] = { texts: [], timer: null };
            messageBuffer[jid].texts.push(text);

            if (messageBuffer[jid].timer) clearTimeout(messageBuffer[jid].timer);

            messageBuffer[jid].timer = setTimeout(async () => {
                const fullText = messageBuffer[jid].texts.join(" ");
                delete messageBuffer[jid];

                const nombre = msg.pushName || "Cliente";
                const fono = jid.split('@')[0].replace(/\D/g, '');
                registrarChat(fono, nombre, fullText);

                const historial = (fs.existsSync(CHAT_HISTORY_FILE) ? JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8'))[fono]?.mensajes || [] : [])
                    .map(m => ({ role: m.from === 'Zara' ? 'assistant' : 'user', content: m.texto }));

                const response = await chatWithGPT(fullText, fono, historial);
                await sock.sendMessage(jid, { text: response });

                let tag = null;
                const lowRes = response.toLowerCase();
                if (lowRes.includes("agendado") || lowRes.includes("retiro") || lowRes.includes("nos vemos")) {
                    tag = "VENTA_VMA"; 
                    await enviarAlerta(STAFF_VMA, `💰 VENTA VMA: ${nombre}`);
                }
                if (lowRes.includes("body elite") && (lowRes.includes("@") || lowRes.includes("correo"))) {
                    tag = "CITA_BODY"; 
                    await enviarAlerta(STAFF_BODY, `✅ CITA BODY: ${nombre}`);
                }
                registrarChat(fono, nombre, response, tag, true);
            }, 5000);
        }
    });
}

app.get('/iniciar-envio', async (req, res) => {
    if (!sock) return res.send("Bot desconectado");
    cargarMapaClientes();
    const filas = fs.readFileSync(CLIENTES_FILE, 'utf-8').split('\n').filter(l => l.trim() !== "");
    res.write("Iniciando Campaña Protegida...\n");
    
    for (let i = 1; i < filas.length; i++) {
        const [fono, nombre] = filas[i].split(',');
        const fonoClean = fono.replace(/\D/g, '');
        const jid = fonoClean + "@s.whatsapp.net";
        const msg = `Hola ${nombre.trim()}, soy Camila de Uniformes VMA. Te escribo para enfrentar a tiempo al fantasma de marzo! ¿Te ayudo con los uniformes?`;
        
        try {
            await sock.sendMessage(jid, { text: msg });
            registrarChat(fonoClean, nombre.trim(), msg, null, true);
            res.write(`✅ [${i}/${filas.length-1}] Enviado a ${nombre}\n`);
            
            const wait = Math.floor(Math.random() * (180000 - 100000 + 1) + 100000);
            await delay(wait);

            if (i % 10 === 0) {
                res.write("❄️ Enfriando cuenta (15 min)...\n");
                await delay(900000);
            }
        } catch (e) { res.write(`❌ Error en ${nombre}\n`); }
    }
    res.end("Campaña finalizada.");
});

app.get('/estado', (req, res) => res.send(`<h1>${webStatus}</h1>`));
app.get('/monitor', (req, res) => res.sendFile(path.join(__dirname, 'public/monitor.html')));
app.get('/api/history', (req, res) => res.json(JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8'))));
app.get('/reset', (req, res) => {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    setTimeout(() => process.exit(0), 1000);
    res.send("Reiniciando...");
});

app.listen(PORT, () => { console.log(`Puerto ${PORT}`); connectToWhatsApp(); });
