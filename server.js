require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const twilio = require('twilio');

const app = report = express();
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 10000;
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

let activeCallSid = null;

// TABLAS DE CONVERSIÓN AUDIO (Tablas de búsqueda rápida para evitar latencia)
const ulawToPcmTable = new Int16Array(256);
const BIAS = 0x84;

function initAudioTables() {
    for (let i = 0; i < 256; i++) {
        let ulaw = ~i;
        let sign = ulaw & 0x80;
        let exponent = (ulaw >> 4) & 0x07;
        let mantissa = ulaw & 0x0F;
        let sample = ((mantissa << 3) + BIAS) << exponent;
        sample -= BIAS;
        ulawToPcmTable[i] = sign ? -sample : sample;
    }
}
initAudioTables();

function encodeMuLawSample(pcm) {
    let sign = (pcm & 0x8000) >> 8;
    if (pcm < 0) { pcm = -pcm; pcm -= 1; }
    if (pcm > 32635) pcm = 32635;
    pcm += BIAS;
    let exponent = 7;
    for (let mask = 0x4000; (pcm & mask) == 0 && exponent > 0; mask >>= 1) { exponent--; }
    let mantissa = (pcm >> (exponent + 3)) & 0x0F;
    return ~(sign | (exponent << 4) | mantissa) & 0xFF;
}

// CONVERSOR 1: Teléfono (8kHz u-law) ➡️ OpenAI (24kHz PCM16)
function twilioToOpenAI(ulawBuffer) {
    const outBuffer = Buffer.alloc(ulawBuffer.length * 6);
    let outIdx = 0;
    for (let i = 0; i < ulawBuffer.length; i++) {
        const pcmSample = ulawToPcmTable[ulawBuffer[i]];
        for (let r = 0; r < 3; r++) { // Triplicamos la tasa de muestreo (8kHz -> 24kHz)
            outBuffer.writeInt16LE(pcmSample, outIdx);
            outIdx += 2;
        }
    }
    return outBuffer.toString('base64');
}

// CONVERSOR 2: OpenAI (24kHz PCM16) ➡️ Teléfono (8kHz u-law)
function openAIToTwilio(pcmBase64) {
    const inBuffer = Buffer.from(pcmBase64, 'base64');
    const outBuffer = Buffer.alloc(Math.floor(inBuffer.length / 6));
    let outIdx = 0;
    for (let i = 0; i < inBuffer.length; i += 6) { // Reducimos la tasa de muestreo tomando 1 de cada 3 muestras
        if (i + 1 < inBuffer.length) {
            const pcmSample = inBuffer.readInt16LE(i);
            outBuffer[outIdx++] = encodeMuLawSample(pcmSample);
        }
    }
    return outBuffer.toString('base64');
}

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
        activeCallSid = call.sid;
        res.status(200).json({ success: true, callSid: call.sid });
    } catch (error) {
        console.error('Error al realizar la llamada:', error);
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
        console.error('Error al colgar:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

const server = app.listen(PORT, () => console.log(`Servidor de traducción con Transcodificación corriendo en puerto ${PORT}`));
const wss = new WebSocket.Server({ server });

let openAIWsToEnglish = null; 
let openAIWsToSpanish = null; 

let twilioWs = null;
let browserWs = null;
let twilioStreamSid = null;

let twilioPacketsIn = 0;

function initOpenAIToEnglish() {
    if (openAIWsToEnglish && openAIWsToEnglish.readyState === WebSocket.OPEN) return;

    console.log('Conectando a OpenAI [Canal Español ➡️ Inglés]... 🇺🇸');
    
    openAIWsToEnglish = new WebSocket('wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate', {
        headers: {
            "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
            "OpenAI-Safety-Identifier": "traductor-to-english-prod"
        }
    });

    openAIWsToEnglish.on('open', () => {
        console.log('✅ OpenAI [Canal Inglés] conectado con éxito.');
        openAIWsToEnglish.send(JSON.stringify({
            type: "session.update",
            session: { audio: { output: { language: "en" } } }
        }));
    });

    openAIWsToEnglish.on('message', (message) => {
        try {
            const response = JSON.parse(message);
            if (response.type === 'error') console.error('❌ [ERROR OPENAI EN]:', response.error);

            if (response.type === 'session.input_transcript.delta') {
                process.stdout.write(`🎙️ [Tu Micrófono dice]: ${response.delta}\n`);
            }
            if (response.type === 'session.output_transcript.delta') {
                process.stdout.write(`🇺🇸 [Traducción al Inglés generada]: ${response.delta}\n`);
            }

            // OpenAI entrega 24kHz PCM16 -> Convertimos a 8kHz u-law para Twilio
            if (response.type === 'session.output_audio.delta' && response.delta) {
                if (twilioWs && twilioWs.readyState === WebSocket.OPEN && twilioStreamSid) {
                    const convertedAudio = openAIToTwilio(response.delta);
                    twilioWs.send(JSON.stringify({ 
                        event: "media", 
                        streamSid: twilioStreamSid, 
                        media: { payload: convertedAudio } 
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

function initOpenAIToSpanish() {
    if (openAIWsToSpanish && openAIWsToSpanish.readyState === WebSocket.OPEN) return;

    console.log('Conectando a OpenAI [Canal Inglés ➡️ Español]... 🇪🇸');
    
    openAIWsToSpanish = new WebSocket('wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate', {
        headers: {
            "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
            "OpenAI-Safety-Identifier": "traductor-to-spanish-prod"
        }
    });

    openAIWsToSpanish.on('open', () => {
        console.log('✅ OpenAI [Canal Español] conectado con éxito.');
        openAIWsToSpanish.send(JSON.stringify({
            type: "session.update",
            session: { audio: { output: { language: "es" } } } // Limpio, sin parámetros inválidos
        }));
    });

    openAIWsToSpanish.on('message', (message) => {
        try {
            const response = JSON.parse(message);
            if (response.type === 'error') console.error('❌ [ERROR OPENAI ES]:', response.error);

            if (response.type === 'session.input_transcript.delta') {
                process.stdout.write(`📞 [El Teléfono dice]: ${response.delta}\n`);
            }
            if (response.type === 'session.output_transcript.delta') {
                process.stdout.write(`🇪🇸 [Traducción al Español generada]: ${response.delta}\n`);
            }

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

wss.on('connection', (ws, req) => {
    const urlClara = new URL(req.url, `http://${req.headers.host}`);
    const pathname = urlClara.pathname;

    if (pathname === '/browser-stream') {
        console.log('🚀 Navegador vinculado.');
        browserWs = ws;
        initOpenAIToEnglish();

        ws.on('message', (message) => {
            if (openAIWsToEnglish && openAIWsToEnglish.readyState === WebSocket.OPEN) {
                openAIWsToEnglish.send(JSON.stringify({
                    type: "session.input_audio_buffer.append",
                    audio: message.toString('base64')
                }));
            }
        });

        ws.on('close', () => { browserWs = null; });
    } 
    
    else if (pathname === '/media-stream') {
        console.log('🚀 Twilio vinculado.');
        twilioWs = ws;
        initOpenAIToSpanish();

        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                
                if (data.event === 'start') {
                    twilioStreamSid = data.start.streamSid;
                    console.log(` Enlace fijado: ${twilioStreamSid}`);
                }

                if (data.event === 'media') {
                    twilioPacketsIn++;
                    if (twilioPacketsIn % 100 === 0) {
                        console.log(`📥 [DIAGNÓSTICO]: Procesando y convirtiendo audio de Twilio... (${twilioPacketsIn} paquetes)`);
                    }

                    if (openAIWsToSpanish && openAIWsToSpanish.readyState === WebSocket.OPEN) {
                        // Twilio entrega 8kHz u-law -> Convertimos a 24kHz PCM16 antes de inyectar a OpenAI
                        const convertedAudio = twilioToOpenAI(Buffer.from(data.media.payload, 'base64'));
                        openAIWsToSpanish.send(JSON.stringify({
                            type: "session.input_audio_buffer.append",
                            audio: convertedAudio
                        }));
                    }
                }
            } catch (err) {
                console.error("Error en flujo Twilio:", err);
            }
        });

        ws.on('close', () => { 
            twilioWs = null; 
            twilioStreamSid = null;
        });
    }
});
