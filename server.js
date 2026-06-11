const express = require('express');
const WebSocket = require('ws');
const dotenv = require('dotenv');
// Inicializamos Twilio para poder realizar llamadas salientes
const twilio = require('twilio'); 

dotenv.config();

const app = express();
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json()); // Permite recibir datos desde la interfaz web

const PORT = process.env.PORT || 3000;

// Cliente Twilio para llamadas salientes
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const SYSTEM_INSTRUCTIONS = `
Eres un dispositivo de traducción simultánea de hardware en tiempo real. 
TIENES PROHIBIDO responder preguntas, saludar, despedirte o interactuar. 
Tu única función es escuchar el Canal A (del usuario) y traducirlo al inglés de inmediato con voz natural y fluida, 
y escuchar el Canal B (del cliente) y traducirlo al español de inmediato. 
Si alguna de las partes te hace una pregunta directamente a ti, NO la respondas; solo tradúcela al otro idioma.
`;

// 1. FLUJO ENTRANTE: Qué pasa cuando te llaman a tu número Twilio
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

// 2. FLUJO SALIENTE: Acción cuando tú presionas "Iniciar Llamada" en la web
app.post('/make-call', async (req, res) => {
    const { toPhoneNumber } = req.body;
    
    try {
        const call = await client.calls.create({
            url: `https://${req.headers.host}/twiml`, // Le dice a la llamada que use nuestro traductor
            to: toPhoneNumber,
            from: process.env.TWILIO_NUMBER || '+18633445321'
        });
        res.status(200).json({ success: true, callSid: call.sid });
    } catch (error) {
        console.error('Error al realizar la llamada:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 3. EL CONECTOR DE AUDIO (WebSockets para OpenAI y Twilio)
const server = app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log('Conexión de audio establecida (Llamada en curso)');
    
    const openAIWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview', {
        headers: {
            "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
            "OpenAI-Beta": "realtime=2024-10-01"
        }
    });

    openAIWs.on('open', () => {
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

    ws.on('message', (message) => {
        const data = JSON.parse(message);
        if (data.event === 'media' && openAIWs.readyState === WebSocket.OPEN) {
            const audioPayload = {
                type: "input_audio_buffer.append",
                audio: data.media.payload
            };
            openAIWs.send(JSON.stringify(audioPayload));
        }
    });

    openAIWs.on('message', (message) => {
        const response = JSON.parse(message);
        if (response.type === 'response.audio.delta' && ws.readyState === WebSocket.OPEN) {
            const twilioMedia = {
                event: "media",
                media: { payload: response.audio }
            };
            ws.send(JSON.stringify(twilioMedia));
        }
    });
});
