const express = require('express');
const WebSocket = require('ws');
const dotenv = require('dotenv');
const twilio = require('twilio');
const url = require('url');

dotenv.config();

const app = express();
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

let activeCallSid = null; // Guarda el ID de la llamada para poder colgarla

const SYSTEM_INSTRUCTIONS = `
Eres un dispositivo de traducción simultánea de hardware en tiempo real. 
TIENES PROHIBIDO responder preguntas, saludar, despedirte o interactuar. 
Tu única función es escuchar al usuario (que hablará en español) y traducirlo al inglés de inmediato con voz natural, 
y escuchar al proveedor (que hablará en inglés) y traducirlo al español de inmediato. 
Si alguna de las partes te hace una pregunta directamente a ti, NO la respondas; solo tradúcela al otro idioma.
`;

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

app.post('/make-call', async (req, res) => {
    const { toPhoneNumber } = req.body;
    try {
        const call = await client.calls.create({
            url: `https://${req.headers.host}/twiml`,
            to: toPhoneNumber,
            from: process.env.TWILIO_NUMBER || '+18633445321'
        });
        activeCallSid = call.sid; // Guardamos el SID de la llamada activa
        res.status(200).json({ success: true, callSid: call.sid });
    } catch (error) {
        console.error('Error al realizar la llamada:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// NUEVA RUTA: Permite colgar la llamada desde la interfaz web
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

const server = app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
const wss = new WebSocket.Server({ server });

let openAIWs = null;
let twilioWs = null;
let browserWs = null;
let twilioStreamSid = null; // IMPORTANTE: Guardar el puente de Twilio

function initOpenAI() {
    if (openAIWs && openAIWs.readyState === WebSocket.OPEN) return;

    console.log('Conectando con OpenAI Realtime API...');
    openAIWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview', {
        headers: {
            "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
            "OpenAI-Beta": "realtime=2024-10-01"
        }
    });

    openAIWs.on('open', () => {
        console.log('Conectado a OpenAI con éxito.');
        const sessionUpdate = {
            type: "session.update",
            session: {
                modalities: ["audio", "text"],
                instructions: SYSTEM_INSTRUCTIONS,
                voice: "alloy",
                input_audio_format: "g711_ulaw",
                output_audio_format: "g711_ulaw"
            }
        };
        openAIWs.send(JSON.stringify(sessionUpdate));
    });

    openAIWs.on('message', (message) => {
        const response = JSON.parse(message);
        
        // CORRECCIÓN CRÍTICA: El objeto es response.delta, no response.audio
        if (response.type === 'response.audio.delta' && response.delta) {
            // Reenviar a Twilio usando su identificador obligatorio (streamSid)
            if (twilioWs && twilioWs.readyState === WebSocket.OPEN && twilioStreamSid) {
                twilioWs.send(JSON.stringify({ 
                    event: "media", 
                    streamSid: twilioStreamSid, 
                    media: { payload: response.delta } 
                }));
            }
            // Reenviar al navegador
            if (browserWs && browserWs.readyState === WebSocket.OPEN) {
                browserWs.send(JSON.stringify({ type: 'audio', payload: response.delta }));
            }
        }
    });
}

wss.on('connection', (ws, req) => {
    const pathname = url.parse(req.url).pathname;

    if (pathname === '/browser-stream') {
        console.log('Navegador móvil WebRTC enlazado al audio.');
        browserWs = ws;
        initOpenAI();

        ws.on('message', (message) => {
            if (openAIWs && openAIWs.readyState === WebSocket.OPEN) {
                openAIWs.send(JSON.stringify({
                    type: "input_audio_buffer.append",
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
            const data = JSON.parse(message);
            
            // CORRECCIÓN CRÍTICA: Capturar el identificador de transmisión de Twilio
            if (data.event === 'start') {
                twilioStreamSid = data.start.streamSid;
                console.log(`Enlace de audio Twilio fijado: ${twilioStreamSid}`);
            }

            if (data.event === 'media' && openAIWs && openAIWs.readyState === WebSocket.OPEN) {
                openAIWs.send(JSON.stringify({
                    type: "input_audio_buffer.append",
                    audio: data.media.payload
                }));
            }
        });

        ws.on('close', () => { 
            twilioWs = null; 
            twilioStreamSid = null;
        });
    }
});
