require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Validación crítica de entorno para no colgar el servidor
if (!process.env.OPENAI_API_KEY) {
    console.error("❌ [ERROR CRÍTICO]: La variable OPENAI_API_KEY no está definida.");
    process.exit(1);
}

// ==========================================
// ALGORITMOS DE CONVERSIÓN TELEFÓNICA (Twilio <-> OpenAI)
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

// Convierte audio de Twilio (8kHz Mu-law) a formato OpenAI (24kHz PCM16)
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

// Convierte audio de OpenAI (24kHz PCM16) al formato telefónico de Twilio (8kHz Mu-law)
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
// CONEXIÓN TELEFÓNICA CON LA REALTIME API (GA)
// ==========================================
function iniciarSesionOpenAI(clientWs, idiomaDestino, twilioStreamSid) {
    console.log("☎️ [OPENAI]: Abriendo canal de traducción para la llamada...");

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
        console.log("✅ [OPENAI]: Enlazado con éxito al motor de traducción.");
        
        // Configuración requerida por la versión GA de OpenAI para establecer idioma
        const configuracionInicial = {
            type: "session.update",
            session: {
                audio: {
                    output: {
                        language: idiomaDestino // Se configura el idioma destino de la llamada
                    }
                }
            }
        };
        openAiWs.send(JSON.stringify(configuracionInicial));
    });

    openAiWs.on("message", (data) => {
        try {
            const event = JSON.parse(data);

            // Escuchar respuesta de audio de OpenAI, convertirla a formato telefónico y mandarla a Twilio
            if (event.type === "session.output_audio.delta" && event.delta) {
                const pcmBuffer = Buffer.from(event.delta, 'base64');
                const mulawBuffer = pcm16ToMulaw8kHz(pcmBuffer);
                
                if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({
                        event: "media",
                        streamSid: twilioStreamSid,
                        media: {
                            payload: mulawBuffer.toString('base64')
                        }
                    }));
                }
            }

            // Monitorear cierres de sesión controlados por OpenAI
            if (event.type === "session.closed") {
                console.log("💡 [OPENAI]: Sesión finalizada.");
                clientWs.close();
            }

        } catch (error) {
            console.error("❌ Error en puente de datos OpenAI:", error);
        }
    });

    openAiWs.on("error", (error) => {
        console.error("❌ [ERROR DE OPENAI]:", error);
    });

    return openAiWs;
}

// ==========================================
// CAPTURA DEL FLUJO DE AUDIO DE TWILIO (WEBSOCKET)
// ==========================================
wss.on("connection", (ws, req) => {
    console.log("📞 [SERVIDOR]: Conexión entrante detectada...");
    
    let openAiWs = null;
    let twilioStreamSid = null;

    ws.on("message", (message) => {
        try {
            const msg = JSON.parse(message);

            // 1. Cuando la llamada inicia y Twilio nos da el identificador del Stream
            if (msg.event === "start") {
                twilioStreamSid = msg.start.streamSid;
                console.log(`🚀 [TWILIO]: Línea telefónica enlazada. ID Stream: ${twilioStreamSid}`);
                
                // Iniciamos la sesión traduciendo a Español ('es') de forma predeterminada
                openAiWs = iniciarSesionOpenAI(ws, "es", twilioStreamSid);
            }

            // 2. Transmisión constante de audio desde el teléfono hacia OpenAI
            if (msg.event === "media" && openAiWs && openAiWs.readyState === WebSocket.OPEN) {
                const rawMulaw = Buffer.from(msg.media.payload, 'base64');
                const pcm24kHz = mulaw8kHzToPcm16_24kHz(rawMulaw);

                openAiWs.send(JSON.stringify({
                    type: "session.input_audio_buffer.append",
                    audio: pcm24kHz.toString('base64')
                }));
            }

            // 3. Cuando el usuario cuelga el teléfono
            if (msg.event === "stop") {
                console.log("🛑 [TWILIO]: Llamada finalizada (El usuario colgó).");
                if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
                    openAiWs.send(JSON.stringify({ type: "session.close" }));
                }
            }
        } catch (error) {
            console.error("❌ Error procesando el flujo de Twilio:", error);
        }
    });

    ws.on("close", () => {
        console.log("🔌 [SERVIDOR]: Conexión del socket telefónico cerrada.");
        if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
            openAiWs.send(JSON.stringify({ type: "session.close" }));
        }
    });
});

// ==========================================
// ENDPOINT PRINCIPAL: RESPUESTA TWIML TELEFÓNICA
// ==========================================
// Cambiado a la ruta raíz '/' para que cuando Twilio apunte a tu app de Render, reciba directamente las instrucciones telefónicas.
app.all('/', (req, res) => {
    res.type('text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
        <Response>
            <Say language="es-MX">Conectando al traductor en tiempo real, por favor hable después del tono.</Say>
            <Connect>
                <Stream url="wss://${req.headers.host}/" />
            </Connect>
        </Response>
    `);
});

// Inicialización del Servidor Telefónico
server.listen(PORT, () => {
    console.log(`🎙️ Servidor de telefonía corriendo en puerto ${PORT}`);
});
