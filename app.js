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
const CHAT_HISTORY_FILE = "/data/historial_chats.json";
const AUTH_DIR = "/data/auth_info_baileys";

let sock;
let botActivo = false; 
let webStatus = "⏸️ MODO OBSERVADOR";

function registrarChat(fono, nombre, mensaje, tag = null, esBot = false) {
    try {
        let chats = fs.existsSync(CHAT_HISTORY_FILE) ? JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8')) : {};
        if (!chats[fono]) chats[fono] = { nombre, mensajes: [], unread: 0, lastTs: 0, tags: [] };
        
        // LÓGICA DE AUTO-ETIQUETADO (Para que las pestañas no estén vacías)
        const msgLow = mensaje.toLowerCase();
        if (msgLow.includes("talla") || msgLow.includes("uniforme") || msgLow.includes("colegio") || msgLow.includes("precio") || msgLow.includes("formal")) {
            if (!chats[fono].tags.includes("VENTA_VMA")) chats[fono].tags.push("VENTA_VMA");
        }
        if (msgLow.includes("body") || msgLow.includes("evaluacion") || msgLow.includes("clinica") || msgLow.includes("hifu")) {
            if (!chats[fono].tags.includes("CITA_BODY")) chats[fono].tags.push("CITA_BODY");
        }

        if (tag && !chats[fono].tags.includes(tag)) chats[fono].tags.push(tag);
        
        chats[fono].mensajes.push({ hora: new Date().toLocaleTimeString('es-CL'), texto: mensaje, from: esBot ? 'Zara' : 'Cliente' });
        chats[fono].lastTs = Date.now();
        if (!esBot) chats[fono].unread++; else chats[fono].unread = 0;
        fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(chats, null, 2));
        return true;
    } catch (e) { return false; }
}

app.get('/encender-zara', (req, res) => { botActivo = true; res.send("Despertando..."); });
app.get('/api/history', (req, res) => {
    if (fs.existsSync(CHAT_HISTORY_FILE)) res.json(JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8')));
    else res.json({});
});
app.get('/monitor', (req, res) => res.sendFile(path.join(__dirname, 'public/monitor.html')));
app.listen(PORT, () => { console.log("Servidor listo"); });
