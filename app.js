const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require("@whiskeysockets/baileys");
const pino = require("pino");
const express = require("express");
const fs = require("fs");
const path = require("path");
const { chatWithGPT } = require("./services/chatgpt");
require("dotenv").config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MONITOR_PASSWORD = process.env.MONITOR_PASSWORD || "123456";
const CHAT_HISTORY_FILE = "/data/historial_chats.json";
const CLIENTES_FILE = path.join(__dirname, "clientes.csv");

let sock;

// Registro de mensajes para la consola visual [cite: 2026-01-30]
function registrarChat(jid, nombre, mensaje, esBot = false) {
    let chats = {};
    try {
        if (fs.existsSync(CHAT_HISTORY_FILE)) chats = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8'));
        if (!chats[jid]) chats[jid] = { nombre, mensajes: [] };
        chats[jid].mensajes.push({
            hora: new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' }),
            texto: mensaje,
            from: esBot ? 'Camila' : 'Cliente'
        });
        if (chats[jid].mensajes.length > 25) chats[jid].mensajes.shift();
        fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(chats, null, 2));
    } catch (e) { console.error("Error historial:", e); }
}

// === RUTA DE LANZAMIENTO REAL ===
app.get('/iniciar-envio', async (req, res) => {
    if (!fs.existsSync(CLIENTES_FILE)) return res.status(404).send("Archivo clientes.csv no encontrado");
    
    const contenido = fs.readFileSync(CLIENTES_FILE, 'utf-8').split('\n').filter(l => l.trim() !== "");
    const filas = contenido.slice(1); // Ignorar cabecera

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.write("🚀 Iniciando campaña real...\n\n");

    for (const linea of filas) {
        const [nombre, fono] = linea.split(',');
        if (fono && fono.trim() !== "") {
            const jid = fono.trim() + "@s.whatsapp.net";
            const texto = `Hola ${nombre.trim()}, soy Camila de VMA. Te escribo para dejar listos los uniformes hoy y ahorrarte las filas de marzo 🏃💨. ¿Te ayudo con tallas o precios?`;
            
            try {
                await sock.sendMessage(jid, { text: texto });
                registrarChat(jid, nombre.trim(), texto, true);
                res.write(`✅ Enviado: ${nombre.trim()} (${fono.trim()})\n`);
                await delay(5000); // Pausa anti-bloqueo
            } catch (err) {
                res.write(`❌ Error en ${nombre.trim()}: ${err.message}\n`);
            }
        }
    }
    res.end("\n🏁 Envío masivo completado.");
});

// === MONITOR DE CHATS EN VIVO ===
app.get('/monitor', (req, res) => {
    const auth = req.headers.authorization;
    if (!auth || Buffer.from(auth.split(' ')[1], 'base64').toString().split(':')[1] !== MONITOR_PASSWORD) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Monitor"');
        return res.status(401).send('Acceso denegado');
    }

    let htmlChats = '<p style="text-align:center;">Esperando respuestas...</p>';
    if (fs.existsSync(CHAT_HISTORY_FILE)) {
        const chats = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8'));
        htmlChats = Object.keys(chats).reverse().map(jid => `
            <div style="background:white; border-radius:10px; padding:15px; margin-bottom:15px; border-left:5px solid #0084ff; box-shadow:0 2px 4px rgba(0,0,0,0.05);">
                <h4 style="margin:0 0 10px 0;">👤 ${chats[jid].nombre} <small style="color:#888;">(${jid.split('@')[0]})</small></h4>
                <div style="background:#f7f8fa; padding:10px; border-radius:8px; font-size:0.9em;">
                    ${chats[jid].mensajes.map(m => `
                        <p style="margin:5px 0; text-align:${m.from === 'Camila' ? 'right' : 'left'}">
                            <span style="background:${m.from === 'Camila' ? '#0084ff' : '#e4e6eb'}; color:${m.from === 'Camila' ? 'white' : 'black'}; padding:5px 10px; border-radius:10px; display:inline-block;">
                                <b>${m.from}:</b> ${m.texto}
                            </span>
                        </p>
                    `).join('')}
                </div>
            </div>
        `).join('');
    }

    res.send(`
        <html>
            <head><meta http-equiv="refresh" content="10"><title>Consola Camila</title></head>
            <body style="font-family:sans-serif; background:#f0f2f5; padding:20px;">
                <div style="max-width:700px; margin:auto;">
                    <h1 style="text-align:center; color:#1c1e21;">💬 Chats en Tiempo Real</h1>
                    ${htmlChats}
                </div>
            </body>
        </html>
    `);
});

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState("/data/auth_info_baileys");
    sock = makeWASocket({ auth: state, printQRInTerminal: false, browser: ["Ubuntu", "Chrome", "20.0.04"] });
    
    sock.ev.on("connection.update", (u) => {
        if (u.connection === "open") console.log("✅ Camila Online");
        if (u.connection === "close") connectToWhatsApp();
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const jid = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (text) {
            registrarChat(jid, msg.pushName || "Cliente", text, false);
            const response = await chatWithGPT(text, jid);
            await sock.sendMessage(jid, { text: response });
            registrarChat(jid, msg.pushName || "Cliente", response, true);
        }
    });
    sock.ev.on("creds.update", saveCreds);
}

app.listen(PORT, () => {
    console.log(`Servidor listo en puerto ${PORT}`);
    connectToWhatsApp();
});
