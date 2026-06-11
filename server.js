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

let activeCallSid = null; 

const SYSTEM_INSTRUCTIONS = `
Eres un traductor simultáneo automático. 
Tu única función es escuchar español y traducirlo al inglés, y escuchar inglés y traducirlo al español. 
No saludes, no respondas, solo traduce el audio que te llega.
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
    console.log(`📞 Iniciando solicitud de llamada hacia: ${toPhoneNumber}`);
    try {
        const call = await client.calls.create({
            url: `https://${req.headers.host}/twiml`,
            to: toPhoneNumber,
            from: process.env.TWILIO_NUMBER
        });
        activeCallSid = call.sid;
        res.status(200).json({ success: true, callSid: call.sid });
    } catch (error) {
        console.error('❌ Error de Twilio al crear llamada:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

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
        res.status(500).json({ success: false, error: error.message });
    }
});

const server = app.listen(PORT, () => console.log(`🚀 Servidor listo en puerto ${PORT}`));
const wss = new WebSocket.Server({ server });

let openAIWs = null;
let twilioWs = null;
let browserWs = null;
let twilioStreamSid = null;
let browserDataCount = 0; // Contador para no saturar la consola
let twilioDataCount = 0;

function initOpenAI() {
    if (openAIWs && openAIWs.readyState === WebSocket.OPEN) return;

    console.log('🌐 Conectando con OpenAI Realtime API...');
    
    openAIWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview', {
        headers: {
            "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
            "OpenAI-Beta": "realtime=2024-10-01"
        }
    });

    openAIWs.on('open', () => {
        console.log('✅ [CONEXIÓN EXITOSA] OpenAI Realtime está conectado y listo.');
        const sessionUpdate = {
            type: "session.update",
            session: {
                modalities: ["audio", "text"],
                instructions: SYSTEM_INSTRUCTIONS,
                voice: "alloy",
                input_audio_format: "g711_ulaw",
                output_audio_format: "g711_ulaw",
                turn_detection: {
                    type: "server_vad",
                    threshold: 0.5,
                    prefix_padding_ms: 300,
                    silence_duration_ms: 500
                }
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
            if (response.type === 'input_audio_buffer.speech_started') {
                console.log('🎙️ [OpenAI] ¡Detectó voz! Escuchando...');
            }
            if (response.type === 'input_audio_buffer.speech_stopped') {
                console.log('🤫 [OpenAI] Silencio detectado. Procesando traducción...');
            }

            if (response.type === 'response.audio.delta' && response.delta) {
                if (twilioWs && twilioWs.readyState === WebSocket.OPEN && twilioStreamSid) {
                    twilioWs.send(JSON.stringify({ 
                        event: "media", 
                        streamSid: twilioStreamSid, 
                        media: { payload: response.delta } 
                    }));
                }
                if (browserWs && browserWs.readyState === WebSocket.OPEN) {
                    browserWs.send(JSON.stringify({ type: 'audio', payload: response.delta }));
                }
            }
        } catch (err) {
            console.error("Error procesando respuesta de OpenAI:", err);
        }
    });

    openAIWs.on('close', (code, reason) => {
        console.log(`❌ [OPENAI DESCONECTADO] Código: ${code}, Razón: ${reason.toString()}`);
        openAIWs = null;
    });

    openAIWs.on('error', (err) => {
        console.error('❌ [ERROR CRÍTICO EN WEBSOCKET DE OPENAI]:', err);
    });
}

wss.on('connection', (ws, req) => {
    const pathname = url.parse(req.url).pathname;

    if (pathname === '/browser-stream') {
        console.log('💻 Interfaz Web de la PC conectada al servidor.');
        browserWs = ws;
        initOpenAI();

        ws.on('message', (message) => {
            browserDataCount++;
            if(browserDataCount % 100 === 0) {
                console.log('📥 [Audio PC] Flujo continuo de micrófono activo...');
            }
            if (openAIWs && openAIWs.readyState === WebSocket.OPEN) {
                openAIWs.send(JSON.stringify({
                    type: "input_audio_buffer.append",
                    audio: message.toString()
                }));
            }
        });

        ws.on('close', () => { 
            console.log('💻 Interfaz Web desconectada.');
            browserWs = null; 
        });
    } 
    
    else if (pathname === '/media-stream') {
        console.log('📞 Twilio ha enlazado la línea telefónica.');
        twilioWs = ws;
        initOpenAI();

        ws.on('message', (message) => {
            const data = JSON.parse(message);
            
            if (data.event === 'start') {
                twilioStreamSid = data.start.streamSid;
                console.log(`🔗 Enlace de audio fijado con Twilio SID: ${twilioStreamSid}`);
            }

            if (data.event === 'media') {
                twilioDataCount++;
                if(twilioDataCount % 100 === 0) {
                    console.log('📥 [Audio Teléfono] Recibiendo voz desde el celular...');
                }
                if (openAIWs && openAIWs.readyState === WebSocket.OPEN) {
                    openAIWs.send(JSON.stringify({
                        type: "input_audio_buffer.append",
                        audio: data.media.payload
                    }));
                }
            }
        });

        ws.on('close', () => { 
            console.log('📞 Línea telefónica cerrada.');
            twilioWs = null; 
            twilioStreamSid = null;
        });
    }
});
