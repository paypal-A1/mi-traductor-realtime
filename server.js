require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const twilio = require('twilio');

const app = express();
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 10000;
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

let activeCallSid = null; // ID de la llamada telefónica activa

// Endpoint TwiML para enlazar el audio de Twilio
app.post('/twiml', (req, res) => {
    res.type('text/xml');
    res.send(`
        <Response>
            <Connect>
                <Stream url="wss://${req.headers.host}/media-stream" />
            </Connect>
        </Response>
    `);
});

// Endpoint para iniciar la llamada desde tu interfaz web
app.post('/make-call', async (req, res) => {
    const { toPhoneNumber } = req.body;
    try {
        const call = await client.calls.create({
            url: `https://${req.headers.host}/twiml`,
            to: toPhoneNumber,
            from: process.env.TWILIO_NUMBER || '+18633445321'
        });
        activeCallSid = call.sid;
        res.status(200).json({ success: true, callSid: call.sid });
    } catch (error) {
        console.error('Error al realizar la llamada:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Endpoint para colgar la llamada
app.post('/hangup', async (req, res) => {
    try {
        if (activeCallSid) {
            await client.calls(activeCallSid).update({ status: 'completed' });
            activeCallSid = null;
            res.status(200).json({ success: true });
        } else {
            res.status(400).json({ success: false, error: "No hay llamada activa" });
        }
    } catch (error) {
        console.error('Error al colgar:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

const server = app.listen(PORT, () => console.log(`Servidor de traducción corriendo en puerto ${PORT}`));
const wss = new WebSocket.Server({ server });

// DECLARACIÓN DE LAS DOS MICRO-SESIONES DE OPENAI
let openAIWsToEnglish = null; // Escucha tu navegador (Español) -> Traduce al Inglés -> Va al Teléfono
let openAIWsToSpanish = null; // Escucha el Teléfono (Inglés) -> Traduce al Español -> Va a tu Navegador

let twilioWs = null;
let browserWs = null;
let twilioStreamSid = null;

// CANAL 1: Inicializa el traductor dedicado al INGLÉS (Para tu micrófono)
function initOpenAIToEnglish() {
    if (openAIWsToEnglish && openAIWsToEnglish.readyState === WebSocket.OPEN) return;

    console.log('Conectando a OpenAI [Canal Español ➡️ Inglés]...');
    
    openAIWsToEnglish = new WebSocket('wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate', {
        headers: {
            "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
            "OpenAI-Safety-Identifier": "traductor-to-english-prod"
        }
    });

    openAIWsToEnglish.on('open', () => {
        console.log('✅ OpenAI [Canal Inglés] conectado con éxito.');
        // Forzamos a que este canal solo devuelva INGLÉS
        openAIWsToEnglish.send(JSON.stringify({
            type: "session.update",
            session: { audio: { output: { language: "en" } } }
        }));
    });

    openAIWsToEnglish.on('message', (message) => {
        try {
            const response = JSON.parse(message);
            if (response.type === 'error') console.error('❌ [ERROR OPENAI EN]:', response.error);

            // El audio traducido al INGLÉS va directo a la bocina del teléfono (Twilio)
            if (response.type === 'session.output_audio.delta' && response.delta) {
                if (twilioWs && twilioWs.readyState === WebSocket.OPEN && twilioStreamSid) {
                    twilioWs.send(JSON.stringify({ 
                        event: "media", 
                        streamSid: twilioStreamSid, 
                        media: { payload: response.delta } 
                    }));
                }
            }
        } catch (e) {
            console.error("Error en mensaje Canal Inglés:", e);
        }
    });

    openAIWsToEnglish.on('close', () => { openAIWsToEnglish = null; });
    openAIWsToEnglish.on('error', (err) => console.error('Error Canal Inglés:', err));
}

// CANAL 2: Inicializa el traductor dedicado al ESPAÑOL (Para el teléfono del proveedor)
function initOpenAIToSpanish() {
    if (openAIWsToSpanish && openAIWsToSpanish.readyState === WebSocket.OPEN) return;

    console.log('Conectando a OpenAI [Canal Inglés ➡️ Español]...');
    
    openAIWsToSpanish = new WebSocket('wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate', {
        headers: {
            "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
            "OpenAI-Safety-Identifier": "traductor-to-spanish-prod"
        }
    });

    openAIWsToSpanish.on('open', () => {
        console.log('✅ OpenAI [Canal Español] conectado con éxito.');
        // Forzamos a que este canal solo devuelva ESPAÑOL
        openAIWsToSpanish.send(JSON.stringify({
            type: "session.update",
            session: { audio: { output: { language: "es" } } }
        }));
    });

    openAIWsToSpanish.on('message', (message) => {
        try {
            const response = JSON.parse(message);
            if (response.type === 'error') console.error('❌ [ERROR OPENAI ES]:', response.error);

            // El audio traducido al ESPAÑOL va directo a tus audífonos (Navegador Web)
            if (response.type === 'session.output_audio.delta' && response.delta) {
                if (browserWs && browserWs.readyState === WebSocket.OPEN) {
                    browserWs.send(JSON.stringify({ type: 'audio', payload: response.delta }));
                }
            }
        } catch (e) {
            console.error("Error en mensaje Canal Español:", e);
        }
    });

    openAIWsToSpanish.on('close', () => { openAIWsToSpanish = null; });
    openAIWsToSpanish.on('error', (err) => console.error('Error Canal Español:', err));
}

// RUTEO DE CONEXIONES ENTRANTES WEBSOCKET
wss.on('connection', (ws, req) => {
    const urlClara = new URL(req.url, `http://${req.headers.host}`);
    const pathname = urlClara.pathname;

    // Conexión desde tu interfaz Web / Micrófono
    if (pathname === '/browser-stream') {
        console.log('Navegador móvil WebRTC enlazado al audio.');
        browserWs = ws;
        initOpenAIToEnglish(); // Abre el intérprete que traduce al inglés

        ws.on('message', (message) => {
            // Tu voz en español entra únicamente al canal que traduce al inglés
            if (openAIWsToEnglish && openAIWsToEnglish.readyState === WebSocket.OPEN) {
                openAIWsToEnglish.send(JSON.stringify({
                    type: "session.input_audio_buffer.append",
                    audio: message.toString()
                }));
            }
        });

        ws.on('close', () => { browserWs = null; });
    } 
    
    // Conexión desde la llamada de Twilio (Teléfono remotos)
    else if (pathname === '/media-stream') {
        console.log('Línea telefónica activa con Twilio.');
        twilioWs = ws;
        initOpenAIToSpanish(); // Abre el intérprete que traduce al español

        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                
                if (data.event === 'start') {
                    twilioStreamSid = data.start.streamSid;
                    console.log(`Enlace de audio Twilio fijado: ${twilioStreamSid}`);
                }

                // La voz del proveedor en inglés entra únicamente al canal que traduce al español
                if (data.event === 'media' && openAIWsToSpanish && openAIWsToSpanish.readyState === WebSocket.OPEN) {
                    openAIWsToSpanish.send(JSON.stringify({
                        type: "session.input_audio_buffer.append",
                        audio: data.media.payload
                    }));
                }
            } catch (err) {
                console.error("Error en flujo de datos Twilio:", err);
            }
        });

        ws.on('close', () => { 
            twilioWs = null; 
            twilioStreamSid = null;
        });
    }
});
