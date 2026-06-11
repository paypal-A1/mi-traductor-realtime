const express = require('express');
const WebSocket = require('ws');
const dotenv = require('dotenv');
dotenv.config();

const app = express();
app.use(express.static('public')); // Sirve la interfaz visual
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

// 1. INSTRUCCIONES ESTRICTAS PARA OPENAI (Traductor Puro)
const SYSTEM_INSTRUCTIONS = `
Eres un dispositivo de traducción simultánea de hardware en tiempo real. 
TIENES PROHIBIDO responder preguntas, saludar, despedirte o interactuar. 
Tu única función es escuchar el Canal A (del usuario) y traducirlo al inglés de inmediato con voz natural y fluida, 
y escuchar el Canal B (del cliente) y traducirlo al español de inmediato. 
Si alguna de las partes te hace una pregunta directamente a ti, NO la respondas; solo tradúcela al otro idioma.
`;

// 2. Ruta para que Twilio se conecte cuando se inicie la llamada
app.post('/twiml', (req, res) => {
    const phoneNumber = req.body.To;
    
    // TwiML que le dice a Twilio: "Abre un canal de audio WebSocket hacia Render"
    res.type('text/xml');
    res.send(`
        <Response>
            <Connect>
                <Stream url="wss://${req.headers.host}/media-stream" />
            </Connect>
            <Dial>${phoneNumber}</Dial>
        </Response>
    `);
});

// 3. Servidor de WebSockets para manejar el flujo de audio bidireccional
const server = app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log('Conexión de audio establecida desde Twilio (EE. UU.)');
    
    // Abrir conexión en vivo con OpenAI Realtime API
    const openAIWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview', {
        headers: {
            "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
            "OpenAI-Beta": "realtime=2024-10-01"
        }
    });

    // Configurar instrucciones en OpenAI apenas conecte
    openAIWs.on('open', () => {
        const sessionUpdate = {
            type: "session.update",
            session: {
                modalities: ["audio", "text"],
                instructions: SYSTEM_INSTRUCTIONS,
                voice: "alloy", // Voz natural humana
                input_audio_format: "g711_ulaw",
                output_audio_format: "g711_ulaw"
            }
        };
        openAIWs.send(JSON.stringify(sessionUpdate));
    });

    // Aquí el código Node.js puentea los audios de forma independiente
    ws.on('message', (message) => {
        const data = JSON.parse(message);
        
        // Si es audio que viene de Twilio, se lo mandamos directo a OpenAI
        if (data.event === 'media' && openAIWs.readyState === WebSocket.OPEN) {
            const audioPayload = {
                type: "input_audio_buffer.append",
                audio: data.media.payload
            };
            openAIWs.send(JSON.stringify(audioPayload));
        }
    });

    // Cuando OpenAI responde con el audio traducido, se lo inyectamos de vuelta a Twilio
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
