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

let botActivo = false; 
let webStatus = "⏸️ MODO OBSERVADOR";

function clasificarChat(chat) {
    let tags = [];
    const mensajes = chat.mensajes || [];
    if (mensajes.length <= 1) return []; // SI NO HAY RESPUESTA, NO HAY TAG

    const ultimoMensaje = mensajes[mensajes.length - 1];
    const textoCompleto = mensajes.map(m => m.texto.toLowerCase()).join(" ");

    // SOLO ETIQUETA SI EL ÚLTIMO NO ES "ZARA" (Es decir, el cliente habló)
    if (ultimoMensaje.from !== 'Zara') {
        if (textoCompleto.match(/talla|uniforme|colegio|precio|pantal|falda/)) {
            tags.push("VENTA_VMA");
        }
        if (textoCompleto.match(/body|evalua|hifu|lipo|clinica/)) {
            tags.push("CITA_BODY");
        }
    }
    return [...new Set(tags)];
}

app.get('/limpiar-pestanas', (req, res) => {
    try {
        if (fs.existsSync(CHAT_HISTORY_FILE)) {
            let chats = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8'));
            Object.keys(chats).forEach(id => {
                chats[id].tags = clasificarChat(chats[id]);
            });
            fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(chats, null, 2));
            res.send("<h1>✅ Pestañas Limpias. Solo verás a quienes respondieron.</h1>");
        } else { res.send("Sin historial."); }
    } catch (e) { res.status(500).send(e.message); }
});

app.get('/api/history', (req, res) => {
    if (fs.existsSync(CHAT_HISTORY_FILE)) res.json(JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8')));
    else res.json({});
});

app.get('/monitor', (req, res) => res.sendFile(path.join(__dirname, 'public/monitor.html')));
app.listen(PORT, () => { console.log("Servidor listo"); });
