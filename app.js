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

// FUNCIÓN MAESTRA DE ETIQUETADO
function etiquetarChat(mensajes) {
    let tags = [];
    const textoCompleto = mensajes.map(m => m.texto.toLowerCase()).join(" ");
    
    if (textoCompleto.match(/talla|uniforme|colegio|precio|formal|pantal[oó]n|falda|polera|stock/)) {
        tags.push("VENTA_VMA");
    }
    if (textoCompleto.match(/body|evaluaci[oó]n|cl[ií]nica|hifu|lipo|depilaci[oó]n|turno|agendar/)) {
        tags.push("CITA_BODY");
    }
    return tags;
}

// RUTA PARA FORZAR LA CLASIFICACIÓN DEL PASADO
app.get('/limpiar-pestanas', (req, res) => {
    try {
        if (fs.existsSync(CHAT_HISTORY_FILE)) {
            let chats = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8'));
            Object.keys(chats).forEach(id => {
                chats[id].tags = etiquetarChat(chats[id].mensajes);
            });
            fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(chats, null, 2));
            res.send("<h1>✅ Pestañas clasificadas con éxito. Refresca el monitor.</h1>");
        } else { res.send("No hay historial para clasificar."); }
    } catch (e) { res.status(500).send(e.message); }
});

app.get('/api/history', (req, res) => {
    if (fs.existsSync(CHAT_HISTORY_FILE)) res.json(JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8')));
    else res.json({});
});

app.get('/encender-zara', (req, res) => { botActivo = true; res.send("Despertando..."); });
app.get('/monitor', (req, res) => res.sendFile(path.join(__dirname, 'public/monitor.html')));
app.listen(PORT, () => { console.log("Servidor listo"); });
