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
    console.error("❌ [ERROR CRÍTICO]: La variable OPENAI_API_KEY no está definida en el entorno.");
    process.exit(1);
}

// ==========================================
// RUTA INTELIGENTE PARA SERVIR EL FRONTEND
// ==========================================
app.get('/', (req, res) => {
    // Intentamos buscar el HTML en la raíz de ejecución de Render (cwd)
    const pathDesdeCwd = path.join(process.cwd(), 'index.html');
    // Alternativa secundaria basada en el directorio del script
    const pathDesdeDirname = path.join(__dirname, 'index.html');

    res.sendFile(pathDesdeCwd, (err) => {
        if (err) {
            // Si el primero falla, intentamos con la ruta secundaria
            res.sendFile(pathDesdeDirname, (err2) => {
                if (err2) {
                    console.error("❌ [ERROR]: index.html no fue encontrado en ninguna de las rutas esperadas.");
                    console.error("Ruta 1 (CWD):", pathDesdeCwd);
                    console.error("Ruta 2 (DIRNAME):", pathDesdeDirname);
                    
                    res.status(404).send(`
                        <h1>Archivo No Encontrado (404)</h1>
                        <p>Express está activo, pero no se encuentra el archivo <strong>index.html</strong> en tu repositorio.</p>
                        <p>Por favor, asegúrate de que el archivo 'index.html' esté guardado exactamente en la raíz de tu GitHub (al mismo nivel que server.js).</p>
                    `);
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
    // CORREGIDO: Se aplica y asigna la inversión de bits correctamente
    mulawByte = ~mulawByte;
    let sign = mulawByte & 0x80;
    let exponent = (mulawByte & 0x70) >> 4;
    let mantissa = mulawByte & 0x0F;
    let sample = (mantissa << 3) + BIAS;
    sample <<= exponent;
    sample -= BIAS;
    return sign === 0 ? sample : -sample;
}

// Entrada de Twilio (8kHz Mu-law) -> Entrada OpenAI (24kHz PCM16)
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

// Salida OpenAI (24kHz PCM16) -> Entrada de Twilio (8kHz Mu-law)
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
// CONEXIÓN CON LA NUEVA API DE TRADUCCIÓN GA
// ==========================================
function iniciarSesionOpenAI(clientWs, idiomaDestino, tipoFlujo, twilioStreamSid = null) {
    console.log("Conectando con OpenAI Realtime API...");

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
        console.log("✅ Conectado a OpenAI con éxito.");
        
        // Inicializar la configuración del idioma de salida según documentación GA
        const configuracionInicial = {
            type: "session.update",
            session: {
                audio: {
                    output: {
                        language: idiomaDestino
                    }
                }
            }
        };
        openAiWs.send(JSON.stringify(configuracionInicial));
    });

    openAiWs.on("message", (data) => {
        try {
            const event = JSON.parse(data);

            // Manejo de fragmentos de audio traducidos
            if (event.type === "session.output_audio.delta" && event.delta) {
                if (tipoFlujo === "twilio" && twilioStreamSid) {
                    const pcmBuffer = Buffer.from(event.delta, 'base64');
                    const mulawBuffer = pcm16ToMulaw8kHz(pcmBuffer);
                    
                    clientWs.send(JSON.stringify({
                        event: "media",
                        streamSid: twilioStreamSid,
                        media: {
                            payload: mulawBuffer.toString('base64')
                        }
                    }));
                } else if (tipoFlujo === "webrtc") {
                    clientWs.send(JSON.stringify({
                        type: "audio_delta",
                        delta: event.delta
                    }));
                }
            }

            // Manejo de la transcripción del idioma traducido (Subtítulos de Destino)
            if (event.type === "session.output_transcript.delta" && event.delta) {
                clientWs.send(JSON.stringify({
                    type: "transcript_target",
                    delta: event.delta
                }));
            }

            // Manejo de la transcripción del idioma original (Subtítulos de Origen)
            if (event.type === "session.input_transcript.delta" && event.delta) {
                clientWs.send(JSON.stringify({
                    type: "transcript_source",
                    delta: event.delta
                }));
            }

            if (event.type === "session.closed") {
                console.log("💡 Sesión de traducción finalizada formalmente por OpenAI.");
                clientWs.close();
            }

        } catch (error) {
            console.error("❌ Error procesando evento entrante de OpenAI:", error);
        }
    });

    openAiWs.on("error", (error) => {
        console.error("❌ [ERROR DE OPENAI]:", error);
    });

    openAiWs.on("close", (code, reason) => {
        console.log(`🔌 [OPENAI CERRADO] Código: ${code}, Razón: ${reason}`);
    });

    return openAiWs;
}

// ==========================================
// ENRUTAMIENTO PRINCIPAL DE WEBSOCKETS (WSS)
// ==========================================
wss.on("connection", (ws, req) => {
    const urlClara = new URL(req.url, `http://${req.headers.host}`);
    const pathname = urlClara.pathname;
    
    let openAiWs = null;
    let twilioStreamSid = null;

    // CANAL 1: Conexión entrante desde la red telefónica de Twilio
    if (pathname === "/media-stream") {
        console.log("Línea telefónica activa.");

        ws.on("message", (message) => {
            try {
                const msg = JSON.parse(message);

                if (msg.event === "start") {
                    twilioStreamSid = msg.start.streamSid;
                    console.log(`Enlace de audio Twilio fijado: ${twilioStreamSid}`);
                    
                    // Iniciamos la sesión de OpenAI por defecto traduciendo a Español
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

                if (msg.event === "stop") {
                    console.log("Línea telefónica colgada.");
                    if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
                        openAiWs.send(JSON.stringify({ type: "session.close" }));
                    }
                }
            } catch (error) {
                console.error("❌ Error en el procesamiento del flujo Twilio:", error);
            }
        });

        ws.on("close", () => {
            if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
                openAiWs.send(JSON.stringify({ type: "session.close" }));
            }
        });

    // CANAL 2: Conexión entrante desde el Navegador Móvil WebRTC
    } else if (pathname === "/client-stream") {
        console.log("Navegador móvil WebRTC enlazado al audio.");

        ws.on("message", (message) => {
            try {
                const msg = JSON.parse(message);

                if (msg.type === "start_session") {
                    const idiomaElegido = msg.language || "es";
                    openAiWs = iniciarSesionOpenAI(ws, idiomaElegido, "webrtc");
                }

                if (msg.type === "audio_append" && openAiWs && openAiWs.readyState === WebSocket.OPEN) {
                    openAiWs.send(JSON.stringify({
                        type: "session.input_audio_buffer.append",
                        audio: msg.audio
                    }));
                }

                if (msg.type === "stop_session") {
                    if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
                        openAiWs.send(JSON.stringify({ type: "session.close" }));
                    }
                }
            } catch (error) {
                console.error("❌ Error en el procesamiento del navegador móvil:", error);
            }
        });

        ws.on("close", () => {
            if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
                openAiWs.send(JSON.stringify({ type: "session.close" }));
            }
        });
    }
});

// ==========================================
// ENDPOINTS HTTP (TwiML y Autenticación WebRTC)
// ==========================================

// Endpoint para responder a Twilio e iniciar el streaming de audio
app.post('/twilio-twiml', (req, res) => {
    res.type('text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
        <Response>
            <Connect>
                <Stream url="wss://${req.headers.host}/media-stream" />
            </Connect>
        </Response>
    `);
});

// Endpoint para generar credenciales efímeras de cliente (WebRTC Frontend)
app.post("/session", async (req, res) => {
    try {
        const language = req.body.targetLanguage ?? "es";
        const response = await fetch(
            "https://api.openai.com/v1/realtime/translations/client_secrets",
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                    "Content-Type": "application/json",
                    "OpenAI-Safety-Identifier": "traductor-realtime-session-prod",
                },
                body: JSON.stringify({
                    session: {
                        model: "gpt-realtime-translate",
                        audio: {
                            output: { language },
                        },
                    },
                }),
            }
        );
        const data = await response.json();
        res.status(response.status).json(data);
    } catch (error) {
        console.error("❌ Error generando Token Efímero de WebRTC:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Inicialización del Servidor
server.listen(PORT, () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
});
