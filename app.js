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

// Función optimizada para guardar metadatos (hora, unread, etc) [cite: 2026-01-30]
function registrarChat(jid, nombre, mensaje, esBot = false) {
    let chats = {};
    try {
        if (fs.existsSync(CHAT_HISTORY_FILE)) {
            chats = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8'));
        }
        const fonoLimpio = jid.split('@')[0];
        
        if (!chats[fonoLimpio]) {
            chats[fonoLimpio] = { nombre, mensajes: [], unread: 0, lastTs: 0 };
        }
        
        // Agregar mensaje
        chats[fonoLimpio].mensajes.push({
            hora: new Date().toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' }),
            texto: mensaje,
            from: esBot ? 'Zara' : 'Cliente'
        });

        // Actualizar metadatos para el ordenamiento y punto rojo
        chats[fonoLimpio].lastTs = Date.now();
        if (!esBot) { // Solo marcar como no leído si escribe el cliente
            chats[fonoLimpio].unread = (chats[fonoLimpio].unread || 0) + 1;
        } else {
            // Si contesta el bot, asumimos que se leyó (opcional, pero ayuda a limpiar)
             chats[fonoLimpio].unread = 0; 
        }

        // Limitar historial por chat a 50 msgs
        if (chats[fonoLimpio].mensajes.length > 50) chats[fonoLimpio].mensajes.shift();
        
        fs.writeFileSync(CHAT_HISTORY_FILE, JSON.stringify(chats, null, 2));
    } catch (e) { console.error("Error guardando chat:", e); }
}

// Endpoint auxiliar para quitar el punto rojo al hacer clic [cite: 2026-01-30]
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

// === MONITOR TIPO WHATSAPP WEB === [cite: 2026-01-30]
app.get('/monitor', (req, res) => {
    const auth = req.headers.authorization;
    if (!auth || Buffer.from(auth.split(' ')[1], 'base64').toString().split(':')[1] !== MONITOR_PASSWORD) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Monitor"');
        return res.status(401).send('Acceso denegado');
    }

    const chats = fs.existsSync(CHAT_HISTORY_FILE) ? JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf-8')) : {};
    
    // Convertir objeto a array para ordenar por fecha (más nuevo arriba)
    const sortedChats = Object.keys(chats).sort((a, b) => chats[b].lastTs - chats[a].lastTs);

    res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
        <meta charset="UTF-8">
        <title>Zara Monitor</title>
        <style>
            body { margin:0; font-family:'Segoe UI',Helvetica,Arial,sans-serif; background:#d1d7db; height:100vh; display:flex; overflow:hidden; }
            
            /* Lado Izquierdo: Lista de Chats */
            #sidebar { width:30%; min-width:300px; background:#fff; border-right:1px solid #d1d7db; display:flex; flex-direction:column; }
            .header { background:#f0f2f5; padding:10px 16px; height:60px; display:flex; align-items:center; border-bottom:1px solid #d1d7db; font-weight:bold; color:#54656f; flex-shrink:0; }
            #chat-list { flex:1; overflow-y:auto; }
            
            .chat-item { display:flex; align-items:center; padding:12px 15px; cursor:pointer; border-bottom:1px solid #f0f2f5; position:relative; }
            .chat-item:hover { background:#f5f6f6; }
            .chat-item.active { background:#f0f2f5; }
            .avatar { width:45px; height:45px; background:#dfe5e7; border-radius:50%; margin-right:15px; display:flex; align-items:center; justify-content:center; color:#fff; font-size:20px; }
            
            .info { flex:1; overflow:hidden; }
            .top-row { display:flex; justify-content:space-between; margin-bottom:3px; }
            .name { font-size:16px; color:#111b21; font-weight:400; }
            .date { font-size:12px; color:#667781; }
            .preview { font-size:13px; color:#667781; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
            
            .badge { background:#25d366; color:white; font-size:12px; font-weight:bold; padding:2px 6px; border-radius:10px; min-width:15px; text-align:center; }

            /* Lado Derecho: Conversación */
            #main { flex:1; display:flex; flex-direction:column; background:#efeae2; position:relative; }
            #main-header { background:#f0f2f5; padding:10px 16px; height:60px; display:flex; align-items:center; border-bottom:1px solid #d1d7db; flex-shrink:0; }
            #messages-area { flex:1; padding:20px 40px; overflow-y:auto; display:flex; flex-direction:column; background-image: url("https://user-images.githubusercontent.com/15075759/28719144-86dc0f70-73b1-11e7-911d-60d70fcded21.png"); background-repeat: repeat; }
            
            .bubble { max-width:65%; padding:6px 7px 8px 9px; margin-bottom:8px; border-radius:7.5px; position:relative; font-size:14.2px; line-height:19px; color:#111b21; box-shadow:0 1px 0.5px rgba(11,20,26,.13); }
            .bubble.zara { align-self:flex-end; background:#d9fdd3; }
            .bubble.cliente { align-self:flex-start; background:#fff; }
            .bubble-time { float:right; margin-left:15px; font-size:11px; color:#667781; margin-top:5px; }

            .welcome-screen { display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; color:#667781; text-align:center; }
        </style>
    </head>
    <body>

        <div id="sidebar">
            <div class="header">
                <span>Chats (${sortedChats.length})</span>
            </div>
            <div id="chat-list">
                ${sortedChats.map(id => {
                    const c = chats[id];
                    const lastMsg = c.mensajes[c.mensajes.length - 1] || {};
                    const unreadHtml = c.unread > 0 ? \`<div class="badge">\${c.unread}</div>\` : '';
                    return \`
                    <div class="chat-item" onclick="loadChat('\${id}')" id="item-\${id}">
                        <div class="avatar">👤</div>
                        <div class="info">
                            <div class="top-row">
                                <span class="name">\${c.nombre}</span>
                                <span class="date">\${lastMsg.hora || ''}</span>
                            </div>
                            <div class="top-row">
                                <span class="preview">\${lastMsg.texto ? lastMsg.texto.substring(0, 30) + '...' : ''}</span>
                                \${unreadHtml}
                            </div>
                        </div>
                    </div>\`;
                }).join('')}
            </div>
        </div>

        <div id="main">
            <div id="main-header" style="display:none;">
                <div class="avatar">👤</div>
                <div>
                    <div class="name" id="header-name">Nombre</div>
                    <div class="date" id="header-phone">Numero</div>
                </div>
            </div>
            
            <div id="messages-area">
                <div class="welcome-screen">
                    <h2>Monitor Zara VMA</h2>
                    <p>Selecciona un chat para ver la conversación en tiempo real.</p>
                </div>
            </div>
        </div>

        <script>
            const allChats = ${JSON.stringify(chats)};
            let activeChatId = localStorage.getItem('zaraActiveChat');

            // Función para renderizar el chat seleccionado
            function loadChat(id) {
                activeChatId = id;
                localStorage.setItem('zaraActiveChat', id);
                
                const chat = allChats[id];
                if (!chat) return;

                // Marcar como leído visualmente y en servidor
                document.getElementById('item-'+id).querySelector('.badge')?.remove();
                fetch('/mark-read?id=' + id);

                // Update Header
                document.getElementById('main-header').style.display = 'flex';
                document.getElementById('header-name').innerText = chat.nombre;
                document.getElementById('header-phone').innerText = '+ ' + id;

                // Render Messages
                const area = document.getElementById('messages-area');
                area.innerHTML = ''; // Clear previous

                // Ordenar mensajes antiguo -> nuevo (para leer de arriba a abajo)
                // (El servidor ya los guarda en ese orden en el array, no necesitamos sortear de nuevo si push funciona bien)
                
                chat.mensajes.forEach(m => {
                    const div = document.createElement('div');
                    div.className = 'bubble ' + (m.from === 'Zara' ? 'zara' : 'cliente');
                    div.innerHTML = \`\${m.texto}<span class="bubble-time">\${m.hora}</span>\`;
                    area.appendChild(div);
                });

                // Scroll to bottom
                area.scrollTop = area.scrollHeight;

                // Highlight active item
                document.querySelectorAll('.chat-item').forEach(el => el.classList.remove('active'));
                document.getElementById('item-'+id)?.classList.add('active');
            }

            // Auto-reload para datos nuevos sin perder vista
            setTimeout(() => location.reload(), 10000);

            // Restaurar vista al recargar
            window.onload = () => {
                if (activeChatId && allChats[activeChatId]) {
                    loadChat(activeChatId);
                }
            };
        </script>
    </body>
    </html>
    `);
});

// Ruta de disparo masivo
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
                registrarChat(jid, nombre.trim(), msg, true);
                res.write(".");
                await delay(5000);
            } catch (e) { console.error(e); }
        }
    }
    res.end(" Listo.");
});

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState("/data/auth_info_baileys");
    sock = makeWASocket({
        auth: state,
        logger: pino({ level: "error" }),
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

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
            registrarChat(msg.key.remoteJid, msg.pushName || "Cliente", text, false);
            const response = await chatWithGPT(text, msg.key.remoteJid);
            await sock.sendMessage(msg.key.remoteJid, { text: response });
            registrarChat(msg.key.remoteJid, msg.pushName || "Cliente", response, true);
        }
    });
}

app.listen(PORT, () => {
    console.log(`Puerto ${PORT}`);
    connectToWhatsApp();
});
