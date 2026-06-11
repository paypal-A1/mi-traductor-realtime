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

let activeCallSid = null; // Guarda el ID de la llamada activa

const SYSTEM_INSTRUCTIONS = `
Eres un dispositivo de traducción simultánea de hardware en tiempo real. 
TIENES PROHIBIDO responder preguntas, saludar, despedirte o interactuar. 
Tu única función es escuchar al usuario (que hablará en español) y traducirlo al inglés de inmediato con voz natural, 
y escuchar al proveedor (que hablará en inglés) y traducirlo al español de inmediato. 
Si alguna de las partes te hace una pregunta directamente a ti, NO la respondas; solo tradúcela al otro idioma.
`;

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

// Endpoint para colgar la llamada desde tu interfaz web
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

const server = app.listen(PORT, () => console.log(`Servidor de telefonía corriendo en puerto ${PORT}`));
const wss = new WebSocket.Server({ server });

let openAIWs = null;
let twilioWs = null;
let browserWs = null;
let twilioStreamSid = null;

function initOpenAI() {
    if (openAIWs && openAIWs.readyState === WebSocket.OPEN) return;

    console.log('Conectando con la API de traducción de OpenAI...');
    
    // URL de producción requerida por el modelo gpt-realtime-translate
    openAIWs = new WebSocket('wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate', {
        headers: {
            "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
            "OpenAI-Safety-Identifier": "traductor-realtime-session-prod"
        }
    });

    openAIWs.on('open', () => {
        console.log('✅ Conectado a OpenAI de forma exitosa.');
        
        // Estructura de actualización requerida para traducción dedicada
        const sessionUpdate = {
            type: "session.update",
            session: {
                instructions: SYSTEM_INSTRUCTIONS,
                voice: "alloy"
            }
        };
        openAIWs.send(JSON.stringify(sessionUpdate));
    });

    openAIWs.on('message', (message) => {
        try {
            const response = JSON.parse(message);
            
            if (response.type === 'error') {
                console.error('❌ [ERROR DE OPENAI]:', response.error);
            }
            if (response.type === 'session.input_audio_buffer.speech_started') {
                console.log('🎙️ [OpenAI] Detectó voz en la línea. Traduciendo...');
            }

            // Captura los fragmentos de audio traducido (Deltas)
            if (response.type === 'session.output_audio.delta' && response.delta) {
                // Enviar audio de traducción directo a la bocina del teléfono del proveedor (Twilio)
                if (twilioWs && twilioWs.readyState === WebSocket.OPEN && twilioStreamSid) {
                    twilioWs.send(JSON.stringify({ 
                        event: "media", 
                        streamSid: twilioStreamSid, 
                        media: { payload: response.delta } 
                    }));
                }
                // Enviar el mismo audio de traducción a tus audífonos en la interfaz web
                if (browserWs && browserWs.readyState === WebSocket.OPEN) {
                    browserWs.send(JSON.stringify({ type: 'audio', payload: response.delta }));
                }
            }

            if (response.type === 'session.closed') {
                console.log('💡 Sesión de traducción cerrada formalmente por OpenAI.');
                openAIWs = null;
            }
        } catch (e) {
            console.error("Error procesando respuesta de OpenAI:", e);
        }
    });

    openAIWs.on('error', (error) => {
        console.error('❌ [ERROR DE CONEXIÓN WEBSOCKET OPENAI]:', error);
    });

    openAIWs.on('close', (code, reason) => {
        console.log(`🔌 [OPENAI CERRADO] Código: ${code}, Razón: ${reason.toString()}`);
        openAIWs = null;
    });
}

// Servidor de WebSocket con la API de URL estandarizada
wss.on('connection', (ws, req) => {
    const urlClara = new URL(req.url, `http://${req.headers.host}`);
    const pathname = urlClara.pathname;

    if (pathname === '/browser-stream') {
        console.log('Navegador móvil WebRTC enlazado al audio.');
        browserWs = ws;
        initOpenAI();

        ws.on('message', (message) => {
            if (openAIWs && openAIWs.readyState === WebSocket.OPEN) {
                openAIWs.send(JSON.stringify({
                    type: "session.input_audio_buffer.append",
                    audio: message.toString()
                }));
            }
        });

        ws.on('close', () => { browserWs = null; });
    } 
    
    else if (pathname === '/media-stream') {
        console.log('Línea telefónica activa.');
        twilioWs = ws;
        initOpenAI();

        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                
                if (data.event === 'start') {
                    twilioStreamSid = data.start.streamSid;
                    console.log(`Enlace de audio Twilio fijado: ${twilioStreamSid}`);
                }

                if (data.event === 'media' && openAIWs && openAIWs.readyState === WebSocket.OPEN) {
                    openAIWs.send(JSON.stringify({
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
