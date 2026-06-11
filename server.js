require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Validación crítica de entorno
if (!process.env.OPENAI_API_KEY) {
    console.error("❌ [ERROR CRÍTICO]: La variable OPENAI_API_KEY no está definida.");
    process.exit(1);
}

// ==========================================
// SERVIR LA INTERFAZ VISUAL (TU TELÉFONO WEB)
// ==========================================
// Esto hace que Express busque y sirva los estilos, scripts e imágenes de la carpeta public
app.use(express.static(path.join(process.cwd(), 'public')));
app.use(express.static(path.join(__dirname, 'public')));

// Cuando entres a la URL raíz, verás tu preciada interfaz de usuario
app.get('/', (req, res) => {
    const pathDesdeCwd = path.join(process.cwd(), 'public', 'index.html');
    const pathDesdeDirname = path.join(__dirname, 'public', 'index.html');

    res.sendFile(pathDesdeCwd, (err) => {
        if (err) {
            res.sendFile(pathDesdeDirname, (err2) => {
                if (err2) {
                    res.status(404).send("<h1>Error 404</h1><p>No se encontró index.html en la carpeta public.</p>");
                }
            });
        }
    });
});

// ==========================================
// ALGORITMOS DE CONVERSIÓN DE AUDIO CRUDO
// ==========================================
const BIAS = 0x84;
const CLIP = 32635;

function encodeMuLawSample(sample) {
    let sign = (sample & 0x8000) >> 8;
    if (sign !== 0) sample = -sample;
    if (sample > CLIP) sample = CLIP;
    sample += BIAS;
    let exponent = 7;
    for (let bit = 0x4000; (sample & bit) === 0 && exponent > 0; bit >>= 1) {
        exponent--;
    }
    let mantissa = (sample >> (exponent + 3)) & 0x0F;
    let mulawByte = ~(sign | (exponent << 4) | mantissa);
    return mulawByte & 0xFF;
}

function decodeMuLawSample(mulawByte) {
    mulawByte = ~mulawByte;
    let sign = mulawByte & 0x80;
    let exponent = (mulawByte & 0x70) >> 4;
    let mantissa = mulawByte & 0x0F;
    let sample = (mantissa << 3) + BIAS;
    sample <<= exponent;
    sample -= BIAS;
    return sign === 0 ? sample : -sample;
}

function mulaw8kHzToPcm16_24kHz(mulawBuffer) {
    const pcm16Samples = new Int16Array(mulawBuffer.length * 3);
    let idx = 0;
    for (let i = 0; i < mulawBuffer.length; i++) {
        const pcm16Sample = decodeMuLawSample(mulawBuffer[i]);
        pcm16Samples[idx++] = pcm16Sample;
        pcm16Samples[idx++] = pcm16Sample;
        pcm16Samples[idx++] = pcm16Sample;
    }
    return Buffer.from(pcm16Samples.buffer);
}

function pcm16ToMulaw8kHz(pcmBuffer) {
    const pcm16Samples = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.length / 2);
    const mulawLen = Math.floor(pcm16Samples.length / 3);
    const mulawBuffer = Buffer.alloc(mulawLen);
    for (let i = 0; i < mulawLen; i++) {
        const sample = pcm16Samples[i * 3];
        mulawBuffer[i] = encodeMuLawSample(sample);
    }
    return mulawBuffer;
}

// ==========================================
// CONEXIÓN CON LA REALTIME API DE OPENAI (GA)
// ==========================================
function iniciarSesionOpenAI(clientWs, idiomaDestino, tipoFlujo, twilioStreamSid = null) {
    console.log(`🚀 Conectando a OpenAI para flujo: ${tipoFlujo}`);

    const openAiWs = new WebSocket(
        "wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate",
        {
            headers: {
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                "OpenAI-Safety-Identifier": "traductor-realtime-session-prod"
            }
        }
    );

    openAiWs.on("open", () => {
        console.log("✅ Conectado al motor de OpenAI.");
        const configuracionInicial = {
            type: "session.update",
            session: {
                audio: { output: { language: idiomaDestino } }
            }
        };
        openAiWs.send(JSON.stringify(configuracionInicial));
    });

    openAiWs.on("message", (data) => {
        try {
            const event = JSON.parse(data);

            if (event.type === "session.output_audio.delta" && event.delta) {
                if (tipoFlujo === "twilio" && twilioStreamSid) {
                    const pcmBuffer = Buffer.from(event.delta, 'base64');
                    const mulawBuffer = pcm16ToMulaw8kHz(pcmBuffer);
                    clientWs.send(JSON.stringify({
                        event: "media",
                        streamSid: twilioStreamSid,
                        media: { payload: mulawBuffer.toString('base64') }
                    }));
                } else if (tipoFlujo === "webrtc") {
                    // Envía el audio de regreso al teléfono de la interfaz web
                    clientWs.send(JSON.stringify({ type: "audio_delta", delta: event.delta }));
                }
            }

            // Transcripciones de texto para los subtítulos en tu pantalla
            if (event.type === "session.output_transcript.delta" && event.delta) {
                clientWs.send(JSON.stringify({ type: "transcript_target", delta: event.delta }));
            }
            if (event.type === "session.input_transcript.delta" && event.delta) {
                clientWs.send(JSON.stringify({ type: "transcript_source", delta: event.delta }));
            }

            if (event.type === "session.closed") {
                clientWs.close();
            }
        } catch (error) {
            console.error("❌ Error en retransmisión de eventos:", error);
        }
    });

    openAiWs.on("error", (error) => console.error("❌ Error OpenAI:", error));
    return openAiWs;
}

// ==========================================
// ENRUTADOR DE WEBSOCKETS ENTRANTES
// ==========================================
wss.on("connection", (ws, req) => {
    const urlClara = new URL(req.url, `http://${req.headers.host}`);
    const pathname = urlClara.pathname;
    
    let openAiWs = null;
    let twilioStreamSid = null;

    // CANAL A: Si viene de la llamada telefónica de Twilio
    if (pathname === "/media-stream") {
        ws.on("message", (message) => {
            try {
                const msg = JSON.parse(message);
                if (msg.event === "start") {
                    twilioStreamSid = msg.start.streamSid;
                    openAiWs = iniciarSesionOpenAI(ws, "es", "twilio", twilioStreamSid);
                }
                if (msg.event === "media" && openAiWs && openAiWs.readyState === WebSocket.OPEN) {
                    const rawMulaw = Buffer.from(msg.media.payload, 'base64');
                    const pcm24kHz = mulaw8kHzToPcm16_24kHz(rawMulaw);
                    openAiWs.send(JSON.stringify({
                        type: "session.input_audio_buffer.append",
                        audio: pcm24kHz.toString('base64')
                    }));
                }
                if (msg.event === "stop" && openAiWs && openAiWs.readyState === WebSocket.OPEN) {
                    openAiWs.send(JSON.stringify({ type: "session.close" }));
                }
            } catch (e) { console.error(e); }
        });
    } 
    
    // CANAL B: Si viene del "Teléfono" de tu interfaz web
    else if (pathname === "/client-stream" || pathname === "/") {
        ws.on("message", (message) => {
            try {
                const msg = JSON.parse(message);
                if (msg.type === "start_session") {
                    openAiWs = iniciarSesionOpenAI(ws, msg.language || "es", "webrtc");
                }
                if (msg.type === "audio_append" && openAiWs && openAiWs.readyState === WebSocket.OPEN) {
                    openAiWs.send(JSON.stringify({
                        type: "session.input_audio_buffer.append",
                        audio: msg.audio
                    }));
                }
                if (msg.type === "stop_session" && openAiWs && openAiWs.readyState === WebSocket.OPEN) {
                    openAiWs.send(JSON.stringify({ type: "session.close" }));
                }
            } catch (e) { console.error(e); }
        });
    }
});

// ==========================================
// ENDPOINTS DE INTEGRACIÓN EXTERNA
// ==========================================

// Endpoint exclusivo para Twilio (Para que no rompa tu pantalla de inicio)
app.all('/twilio-twiml', (req, res) => {
    res.type('text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
        <Response>
            <Say language="es-MX">Conectando al traductor en tiempo real.</Say>
            <Connect>
                <Stream url="wss://${req.headers.host}/media-stream" />
            </Connect>
        </Response>
    `);
});

// Token de autenticación para las conexiones WebRTC de la interfaz web
app.post("/session", async (req, res) => {
    try {
        const language = req.body.targetLanguage ?? "es";
        const response = await fetch("https://api.openai.com/v1/realtime/translations/client_secrets", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                "Content-Type": "application/json",
                "OpenAI-Safety-Identifier": "traductor-realtime-session-prod",
            },
            body: JSON.stringify({
                session: { model: "gpt-realtime-translate", audio: { output: { language } } }
            })
        });
        const data = await response.json();
        res.status(response.status).json(data);
    } catch (error) {
        res.status(500).json({ error: "Internal Server Error" });
    }
});

server.listen(PORT, () => console.log(`Servidor híbrido en puerto ${PORT}`));
