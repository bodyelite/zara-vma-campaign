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

// CONFIG
const PORT = process.env.PORT || 3000;
const MONITOR_PASSWORD = process.env.MONITOR_PASSWORD || "123456";
const CHAT_HISTORY_FILE = "/data/historial_chats.json";
const CLIENTES_FILE = path.join(__dirname, "data", "clientes.csv");
const AUTH_DIR = "/data/auth_info_baileys";
const BOT_NUMBER = "56934424673"; 

let sock;
let webStatus = "⏳ Iniciando...";
let webCode = "";
let qrTimeout = null;
let clientesMap = []; 

// CARGA DE CLIENTES (LA BASE DE LA VERDAD)
function cargarMapaClientes() {
    try {
        if (fs.existsSync(CLIENTES_FILE)) {
            const filas = fs.readFileSync(CLIENTES_FILE, 'utf-8').split('\n').filter(l => l.trim() !== "");
            clientesMap = filas.map(l => {
                const [f, n] = l.split(',');
                // Guardamos fono limpio y nombre en minúsculas para comparar
                return { fono: f.replace(/\D/g, ''), nombre: n ? n.trim() : 'Sin Nombre' };
            });
            console.log(`📚 Base de Clientes cargada: ${clientesMap.length} registros.`);
        }
    } catch (e) { console.error(e); }
}
cargarMapaClientes();

// DESTINATARIOS ALERTAS
const STAFF_VMA = ["56971350852@s.whatsapp.net", "56998251331@s.whatsapp.net", "56937648536@s.whatsapp.net", "218120098701428@s.whatsapp.net"]; 
const STAFF_BODY = ["56983300262@s.whatsapp.net", "56955145504@s.whatsapp.net", "56937648536@s.whatsapp.net", "218120098701428@s.whatsapp.net"];

// UTILIDAD: ENCONTRAR EL NÚMERO REAL
function obtenerFonoMaestro(jid, pushName) {
    let fonoLimpio = jid.replace('@s.whatsapp.net', '').replace('@lid', '').split(':')[0].replace(/\D/g, '');
    
    // 1. Si el número ya está en nuestra lista CSV, es el maestro.
    const exactMatch = clientesMap.find(c => c.fono === fonoLimpio);
    if (exactMatch) return fonoLimpio;

    // 2. Si es un número raro (LID) o no coincide, buscamos por NOMBRE en el CSV
    if (pushName) {
        const nameClean = pushName.toLowerCase();
        const nameMatch = clientesMap.find(c => {
            const dbName = c.nombre.toLowerCase();
            return dbName.includes(nameClean) || nameClean.includes(dbName);
        });
        if (nameMatch) {
            console.log(`🔄 FUSIONANDO IDENTIDAD: ${fonoLimpio} es en realidad ${nameMatch.fono} (${nameMatch.nombre})`);
            return nameMatch.fono; // ¡BINGO! Usamos el del CSV
        }
    }
    return fonoLimpio; // Si no hay match, usamos lo que llegó
}

// ALERTAS
async function enviarAlerta(grupo, mensaje) {
    if (!sock) return;
    for (const d of grupo) { try { await delay(1000); await sock.sendMessage(d, { text: mensaje }); } catch (e) {} }
}

// REGISTRO CON ETIQUETAS (TAGS)
function registrarChat(fonoMaestro, nombre, mensaje, tag = null, esBot = false) {
    try {
        let chats = {};
        if (fs.existsSync(CHAT_HISTORY_FILE)) chats = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8'));
        
        let esNuevo = false;
        if (!chats[fonoMaestro]) {
            chats[fonoMaestro] = { 
                nombre, 
                mensajes: [], 
                unread: 0, 
                lastTs: 0, 
                tags: [] // AQUÍ GUARDAMOS LOS ESTADOS (VMA, BODY, COMPRA)
            };
            esNuevo = true;
        }

        // Agregar Tag si existe y no está repetido
        if (tag && !chats[fonoMaestro].tags.includes(tag)) {
            chats[fonoMaestro].tags.push(tag);
        }

        chats[fonoMaestro].mensajes.push({ 
            hora: new Date().toLocaleTimeString('es-CL'), 
            texto: mensaje, 
            from: esBot ? 'Zara' : 'Cliente' 
        });
        chats[fonoMaestro].lastTs = Date.now();
        
        if (!esBot) chats[fonoMaestro].unread++;
        else chats[fonoMaestro].unread = 0;
        
        if (chats[fonoMaestro].mensajes.length > 40) chats[fonoMaestro].mensajes.shift();
        
        fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(chats, null, 2));
        return esNuevo;
    } catch (e) { return false; }
}

function obtenerHistorial(fono) {
    try {
        if (!fs.existsSync(CHAT_HISTORY_FILE)) return [];
        const chats = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8'));
        return chats[fono] ? chats[fono].mensajes.map(m => ({ role: m.from==='Zara'?'assistant':'user', content: m.texto })) : [];
    } catch (e) { return []; }
}

// CONEXIÓN
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    sock = makeWASocket({ 
        auth: state, 
        printQRInTerminal: false,
        logger: pino({ level: "silent" }),
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        syncFullHistory: false,
        connectTimeoutMs: 60000
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
            } catch (e) { webStatus = "⚠️ Error código"; }
        }, 5000);
    }

    sock.ev.on("connection.update", (u) => {
        const { connection } = u;
        if (connection === "close") connectToWhatsApp();
        else if (connection === "open") { webStatus = "✅ ZARA ONLINE"; webCode = ""; }
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async ({ messages }) => {
        try {
            const msg = messages[0];
            if (!msg.message || msg.key.fromMe) return;
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
            if (text) {
                const nombre = msg.pushName || "Cliente";
                let realJid = msg.key.remoteJid;
                try { if (typeof jidNormalizedUser === 'function') realJid = jidNormalizedUser(realJid) || realJid; } catch(e) {}
                
                // 1. OBTENER EL FONO MAESTRO (Siempre será el del CSV si coincide nombre)
                const fonoMaestro = obtenerFonoMaestro(realJid, nombre);
                
                // 2. REGISTRAR MENSAJE
                const esNuevo = registrarChat(fonoMaestro, nombre, text, null, false);

                if (esNuevo) await enviarAlerta(STAFF_VMA, `🔔 NUEVO: ${nombre} (+${fonoMaestro})`);

                try {
                    const historial = obtenerHistorial(fonoMaestro);
                    const response = await chatWithGPT(text, fonoMaestro, historial);
                    
                    await sock.sendMessage(msg.key.remoteJid, { text: response });
                    
                    // 3. ANALIZAR TAGS (Etiquetas)
                    let tag = null;
                    const botTxt = response.toLowerCase();
                    
                    if (botTxt.includes("resumen") || botTxt.includes("total")) {
                        tag = "VMA_VENTA";
                        await enviarAlerta(STAFF_VMA, `💰 VENTA VMA: ${nombre}`);
                    }
                    if ((botTxt.includes("hifu") || botTxt.includes("lipo")) && !botTxt.includes("agendado")) {
                        tag = "BODY_INTERES";
                        await enviarAlerta(STAFF_BODY, `👀 INTERÉS BODY: ${nombre}`);
                    }
                    if ((botTxt.includes("agendado") || botTxt.includes("te espero")) && botTxt.includes("body")) {
                        tag = "BODY_CITA";
                        await enviarAlerta(STAFF_BODY, `✅ CITA BODY: ${nombre}`);
                    }

                    registrarChat(fonoMaestro, nombre, response, tag, true);

                } catch (gptError) { console.error("Error IA:", gptError); }
            }
        } catch (e) { console.error("Upsert error:", e.message); }
    });
}

// API BORRADO MASIVO
app.post('/api/delete-bulk', (req, res) => {
    try {
        const auth = req.headers.authorization;
        if (!auth || Buffer.from(auth.split(' ')[1], 'base64').toString().split(':')[1] !== MONITOR_PASSWORD) return res.status(401).send('Acceso denegado');
        
        const { ids } = req.body;
        if (!ids || !Array.isArray(ids)) return res.status(400).send("IDs inválidos");

        if (fs.existsSync(CHAT_HISTORY_FILE)) {
            let chats = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8'));
            ids.forEach(id => delete chats[id]);
            fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(chats, null, 2));
            return res.json({ success: true, deleted: ids.length });
        }
        res.json({ success: false });
    } catch(e) { res.status(500).send(e.message); }
});

// RUTAS BASE
app.get('/estado', (req, res) => res.send(`<html><head><meta http-equiv="refresh" content="3"></head><body><h1>${webStatus}</h1><h2>${webCode}</h2></body></html>`));
app.get('/monitor', (req, res) => {
    const auth = req.headers.authorization;
    if (!auth || Buffer.from(auth.split(' ')[1], 'base64').toString().split(':')[1] !== MONITOR_PASSWORD) return res.status(401).send('Acceso denegado');
    res.sendFile(path.join(__dirname, 'public/monitor.html'));
});
app.get('/api/history', (req, res) => { if (fs.existsSync(CHAT_HISTORY_FILE)) res.json(JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8'))); else res.json({}); });

// ENVÍO CAMPAÑA OUTBOUND (USA EL MAPA PARA REGISTRAR BIEN)
app.get('/iniciar-envio', async (req, res) => {
    if (!sock) return res.send("Error: Bot desconectado");
    if (!fs.existsSync(CLIENTES_FILE)) return res.send("Error: Falta clientes.csv");
    cargarMapaClientes(); 
    const filas = fs.readFileSync(CLIENTES_FILE, 'utf-8').split('\n').filter(l => l.trim() !== "");
    res.write("Iniciando envio LENTO (20s)...\n");
    for (let i = 1; i < filas.length; i++) {
        const linea = filas[i];
        const [fono, nombre] = linea.split(',');
        const fonoClean = fono.replace(/\D/g, ''); 
        if (fonoClean.length > 8) {
            const jid = fonoClean + "@s.whatsapp.net";
            const msg = `Hola ${nombre.trim()}, soy Camila de Uniformes VMA. Te escribo para enfrentar a tiempo al fantasma de marzo! ¿Te ayudo con los uniformes?`;
            try {
                await sock.sendMessage(jid, { text: msg });
                // IMPORTANTE: Registramos con el fono limpio para que coincida siempre
                registrarChat(fonoClean, nombre.trim(), msg, null, true);
                res.write(`✅ Enviado a ${nombre}\n`);
                await delay(20000); 
            } catch (e) { res.write(`❌ Error ${nombre}\n`); await delay(5000); }
        }
    }
    res.end("Fin.");
});

app.listen(PORT, () => { console.log(`Puerto ${PORT}`); connectToWhatsApp(); });
