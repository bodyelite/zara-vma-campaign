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
const CLIENTES_FILE = path.join(__dirname, "clientes.csv");

// EQUIPOS DE ALERTA
const STAFF_VMA = ["56971350852@s.whatsapp.net", "56998251331@s.whatsapp.net"]; 
const STAFF_BODY = ["56983300262@s.whatsapp.net", "56955145504@s.whatsapp.net", "56937648536@s.whatsapp.net"];

let sock;

async function enviarAlerta(grupo, mensaje) {
    if (!sock) return;
    for (const numero of grupo) {
        try {
            await sock.sendMessage(numero, { text: mensaje });
        } catch (e) {
            console.error(`Error alerta a ${numero}`, e);
        }
    }
}

function formatearFonoAlerta(jid) {
    const limpio = jid.replace('@s.whatsapp.net', '').replace('@lid', '').split(':')[0];
    // Si es un ID técnico largo (>15 dígitos), lo ocultamos para que no se vea feo
    if (limpio.length > 15) return "(ID Privado - Ver Nombre)";
    return `+${limpio}`;
}

function registrarChat(jid, nombre, mensaje, esBot = false) {
    let chats = {};
    let esNuevo = false;
    try {
        if (fs.existsSync(CHAT_HISTORY_FILE)) {
            chats = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8'));
        }
        
        const fonoLimpio = jid.replace('@s.whatsapp.net', '').replace('@lid', '').split(':')[0];
        
        if (!chats[fonoLimpio]) {
            chats[fonoLimpio] = { nombre, mensajes: [], unread: 0, lastTs: 0 };
            esNuevo = true;
        }
        
        chats[fonoLimpio].mensajes.push({
            hora: new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' }),
            texto: mensaje,
            from: esBot ? 'Zara' : 'Cliente'
        });

        chats[fonoLimpio].lastTs = Date.now();
        if (!esBot) chats[fonoLimpio].unread = (chats[fonoLimpio].unread || 0) + 1;
        else chats[fonoLimpio].unread = 0; 

        if (chats[fonoLimpio].mensajes.length > 60) chats[fonoLimpio].mensajes.shift();
        
        fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(chats, null, 2));
    } catch (e) { console.error("Error guardando chat:", e); }

    return esNuevo;
}

// CEREBRO DE ALERTAS
async function verificarAlertas(realJid, nombre, msgCliente, msgBot, esNuevo) {
    const fonoVisual = formatearFonoAlerta(realJid);
    const clienteTxt = msgCliente.toLowerCase();
    const botTxt = (msgBot || "").toLowerCase();

    // 1. ALERTA VMA: NUEVO
    if (esNuevo && !msgBot) {
        await enviarAlerta(STAFF_VMA, `🔔 *NUEVO CLIENTE VMA*\n👤 ${nombre}\n📱 ${fonoVisual}`);
        return;
    }

    // 2. ALERTA VMA: PEDIDO OK
    if (botTxt.includes("resumen final") && (botTxt.includes("retiro") || botTxt.includes("fecha"))) {
        await enviarAlerta(STAFF_VMA, `✅ *PEDIDO VMA CONFIRMADO*\n👤 ${nombre}\n📱 ${fonoVisual}\n\n📋 *Detalle:*\n${msgBot}`);
    }

    // 3. ALERTA BODY: INTERÉS
    const keywordsBody = ["que hacen", "precio", "lipo", "facial", "agendar", "me interesa", "bueno", "si, gracias", "evaluacion", "body elite"];
    if (keywordsBody.some(k => clienteTxt.includes(k)) && clienteTxt.length > 2) {
         await enviarAlerta(STAFF_BODY, `👀 *INTERÉS BODY DETECTADO*\n👤 ${nombre}\n📱 ${fonoVisual}\n💬 "${msgCliente}"`);
    }

    // 4. ALERTA BODY: AGENDADO
    if (botTxt.includes("body elite") && (botTxt.includes("agendado") || botTxt.includes("reserva"))) {
        await enviarAlerta(STAFF_BODY, `📅 *CITA BODY AGENDADA*\n👤 ${nombre}\n📱 ${fonoVisual}\n\n🤖 *Confirmación:*\n${msgBot}`);
    }
}

// RESTO DE RUTAS
app.get('/mark-read', (req, res) => {
    const fono = req.query.id;
    if (fs.existsSync(CHAT_HISTORY_FILE)) {
        let chats = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8'));
        if (chats[fono]) {
            chats[fono].unread = 0;
            fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(chats, null, 2));
        }
    }
    res.json({ success: true });
});

app.get('/api/history', (req, res) => {
    if (fs.existsSync(CHAT_HISTORY_FILE)) {
        res.json(JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8')));
    } else res.json({});
});

app.get('/api/export-excel', async (req, res) => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Chats VMA-BODY');
    sheet.columns = [
        { header: 'Cliente', key: 'user', width: 15 }, { header: 'Nombre', key: 'name', width: 20 },
        { header: 'Hora', key: 'time', width: 10 }, { header: 'Remitente', key: 'from', width: 10 },
        { header: 'Mensaje', key: 'text', width: 50 }, { header: 'Interés Body', key: 'interest', width: 10 },
        { header: 'Estado', key: 'status', width: 15 }
    ];
    if (fs.existsSync(CHAT_HISTORY_FILE)) {
        const chats = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8'));
        Object.keys(chats).forEach(fono => {
            const chat = chats[fono];
            const msgs = chat.mensajes || [];
            const fullText = msgs.map(m => m.texto).join(" ").toLowerCase();
            let interestBody = (fullText.includes("body") || fullText.includes("evaluacion")) ? "SI" : "NO";
            let status = (fullText.includes("agendado") || fullText.includes("retiro")) ? "Cierre" : "Consulta";
            msgs.forEach(m => sheet.addRow({ user: fono, name: chat.nombre, time: m.hora, from: m.from, text: m.texto, interest: interestBody, status: status }));
        });
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=Reporte.xlsx');
    await workbook.xlsx.write(res);
    res.end();
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
    if (!fs.existsSync(CLIENTES_FILE)) return res.send("Error: No existe clientes.csv");
    const filas = fs.readFileSync(CLIENTES_FILE, 'utf-8').split('\n').filter(l => l.trim() !== "");
    res.write("Enviando...");
    for (const linea of filas.slice(1)) {
        const [fono, nombre] = linea.split(',');
        if (fono) {
            const jid = fono.trim() + "@s.whatsapp.net";
            const msg = `Hola ${nombre.trim()}, soy Camila de VMA. ¿Te ayudo con los uniformes?`;
            try {
                await sock.sendMessage(jid, { text: msg });
                registrarChat(fono.trim(), nombre.trim(), msg, true);
                res.write(".");
                await delay(5000);
            } catch (e) { console.error(e); }
        }
    }
    res.end(" Listo.");
});

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState("/data/auth_info_baileys");
    sock = makeWASocket({ auth: state, logger: pino({ level: "error" }), printQRInTerminal: false, browser: ["Ubuntu", "Chrome", "20.0.04"] });
    sock.ev.on("connection.update", (u) => {
        if (u.connection === "open") console.log("✅ Zara Online");
        if (u.connection === "close") setTimeout(connectToWhatsApp, 5000);
    });
    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (text) {
            // INTENTO DE NORMALIZACIÓN + EXTRACCIÓN REAL
            let realJid = jidNormalizedUser(msg.key.remoteJid);
            if (msg.key.participant) realJid = jidNormalizedUser(msg.key.participant); // A veces viene aquí en grupos/multidispositivo

            const nombre = msg.pushName || "Cliente";
            
            const esNuevo = registrarChat(realJid, nombre, text, false);
            if (esNuevo) await verificarAlertas(realJid, nombre, text, "", true);

            const response = await chatWithGPT(text, realJid);
            await sock.sendMessage(msg.key.remoteJid, { text: response });
            
            registrarChat(realJid, nombre, response, true);
            await verificarAlertas(realJid, nombre, text, response, false);
        }
    });
}

app.listen(PORT, () => { console.log(`Puerto ${PORT}`); connectToWhatsApp(); });
