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

let activeCallSid = null;
let activeCallStartTime = null; // Para monitoreo RAM

// TABLAS DE CONVERSIÓN AUDIO
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

function twilioToOpenAI(ulawBuffer) {
    const outBuffer = Buffer.alloc(ulawBuffer.length * 6);
    let outIdx = 0;
    for (let i = 0; i < ulawBuffer.length; i++) {
        const pcmSample = ulawToPcmTable[ulawBuffer[i]];
        for (let r = 0; r < 3; r++) {
            outBuffer.writeInt16LE(pcmSample, outIdx);
            outIdx += 2;
        }
    }
    return outBuffer.toString('base64');
}

function openAIToTwilio(pcmBase64) {
    const inBuffer = Buffer.from(pcmBase64, 'base64');
    const outBuffer = Buffer.alloc(Math.floor(inBuffer.length / 6));
    let outIdx = 0;
    for (let i = 0; i < inBuffer.length; i += 6) {
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
        activeCallStartTime = Date.now(); // Monitoreo RAM
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
            
            // LOG DE MONITOREO RAM al finalizar llamada
            const memUsage = process.memoryUsage();
            const duracion = activeCallStartTime ? ((Date.now() - activeCallStartTime) / 1000).toFixed(1) : 'desconocida';
            console.log(`📊 [RAM] Llamada finalizada. Duración: ${duracion}s | RSS: ${(memUsage.rss / 1024 / 1024).toFixed(1)} MB | Heap: ${(memUsage.heapUsed / 1024 / 1024).toFixed(1)} MB`);
            activeCallStartTime = null;
            
            res.status(200).json({ success: true });
        } else {
            res.status(400).json({ success: false, error: "No hay llamada activa" });
        }
    } catch (error) {
        console.error('Error al colgar:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// NUEVO ENDPOINT: Descargar conversación
let conversacionTemporal = { lineas: [], timestamp: null };

app.post('/guardar-transcripcion', (req, res) => {
    const { linea, tipo } = req.body; // tipo: 'tu' o 'proveedor'
    if (!conversacionTemporal.lineas) conversacionTemporal.lineas = [];
    conversacionTemporal.lineas.push({
        timestamp: new Date().toISOString(),
        tipo: tipo,
        texto: linea
    });
    res.json({ success: true });
});

app.post('/descargar-conversacion', (req, res) => {
    const { decision } = req.body;
    
    if (decision === 'si' && conversacionTemporal.lineas && conversacionTemporal.lineas.length > 0) {
        let contenido = '';
        for (const l of conversacionTemporal.lineas) {
            const hora = new Date(l.timestamp).toLocaleTimeString();
            if (l.tipo === 'tu') {
                contenido += `[${hora}] Tú: ${l.texto}\n`;
            } else {
                contenido += `[${hora}] Proveedor: ${l.texto}\n`;
            }
        }
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', 'attachment; filename="conversacion.txt"');
        res.send(contenido);
    } else {
        res.json({ success: true, message: "Conversación descartada" });
    }
    
    // Limpiar conversación después de descargar o descartar
    conversacionTemporal = { lineas: [], timestamp: null };
});

const server = app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
const wss = new WebSocket.Server({ server });

let openAIWsToEnglish = null;
let openAIWsToSpanish = null;
let twilioWs = null;
let browserWs = null;
let twilioStreamSid = null;
let twilioPacketsIn = 0;
let browserKeepAliveInterval = null;
let browserConnectionTimer = null; // TIMER PARA LIMITAR KEEPALIVE

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
                // Guardar para descarga de conversación
                fetch('http://localhost:' + PORT + '/guardar-transcripcion', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ linea: response.delta, tipo: 'tu' })
                }).catch(e => console.error('Error guardando transcripción:', e));
            }
            if (response.type === 'session.output_transcript.delta') {
                process.stdout.write(`🇺🇸 [Traducción al Inglés generada]: ${response.delta}\n`);
            }

            if (response.type === 'session.output_audio.delta' && response.delta) {
                console.log(`🔊 [AUDIO -> TELÉFONO]: Reenviando paquete de voz traducido al Inglés.`);
                
                if (!twilioWs) {
                    console.log(`❌ [ERROR] twilioWs es NULL, no se puede enviar audio al teléfono`);
                } else if (twilioWs.readyState !== WebSocket.OPEN) {
                    console.log(`❌ [ERROR] twilioWs estado: ${twilioWs.readyState} (debe ser 1 = OPEN)`);
                } else if (!twilioStreamSid) {
                    console.log(`❌ [ERROR] twilioStreamSid es NULL, no se puede enviar audio`);
                } else {
                    console.log(`✅ twilioWs OK, enviando audio al teléfono...`);
                    const convertedAudio = openAIToTwilio(response.delta);
                    console.log(`📊 Longitud del audio convertido: ${convertedAudio.length} caracteres base64`);
                    twilioWs.send(JSON.stringify({ 
                        event: "media", 
                        streamSid: twilioStreamSid, 
                        media: { payload: convertedAudio } 
                    }));
                    console.log(`✅ Audio enviado al teléfono correctamente`);
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
        // CAMBIO 1: VOZ "CEDAR"
        openAIWsToSpanish.send(JSON.stringify({
            type: "session.update",
            session: { 
                audio: { 
                    output: { 
                        language: "es",
                        voice: "cedar"
                    } 
                } 
            }
        }));
    });

    openAIWsToSpanish.on('message', (message) => {
        try {
            const response = JSON.parse(message);
            if (response.type === 'error') console.error('❌ [ERROR OPENAI ES]:', response.error);

            if (response.type === 'session.input_transcript.delta') {
                process.stdout.write(`📞 [El Teléfono dice]: ${response.delta}\n`);
                // Guardar para descarga de conversación
                fetch('http://localhost:' + PORT + '/guardar-transcripcion', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ linea: response.delta, tipo: 'proveedor' })
                }).catch(e => console.error('Error guardando transcripción:', e));
            }
            if (response.type === 'session.output_transcript.delta') {
                process.stdout.write(`🇪🇸 [Traducción al Español generada]: ${response.delta}\n`);
            }

            if (response.type === 'session.output_audio.delta' && response.delta) {
                console.log(`🔊 [AUDIO -> NAVEGADOR]: Reenviando paquete de voz traducido al Español.`);
                
                if (!browserWs) {
                    console.log(`❌ [ERROR] browserWs es NULL, no se puede enviar audio al navegador`);
                } else if (browserWs.readyState !== WebSocket.OPEN) {
                    console.log(`❌ [ERROR] browserWs estado: ${browserWs.readyState} (debe ser 1 = OPEN)`);
                } else {
                    console.log(`✅ browserWs OK, enviando audio al navegador...`);
                    const convertedAudio = openAIToTwilio(response.delta);
                    console.log(`📊 Longitud del audio convertido: ${convertedAudio.length} caracteres base64`);
                    browserWs.send(JSON.stringify({ type: 'audio', payload: convertedAudio }));
                    console.log(`✅ Audio enviado al navegador correctamente`);
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
        
        // CAMBIO 4: TIMER PARA LIMITAR KEEPALIVE (5 minutos sin llamada = desconectar)
        if (browserConnectionTimer) clearTimeout(browserConnectionTimer);
        browserConnectionTimer = setTimeout(() => {
            if (browserWs && browserWs.readyState === WebSocket.OPEN && !twilioWs) {
                console.log('⏰ Tiempo de espera agotado (5 min sin llamada). Cerrando conexión del navegador.');
                browserWs.close();
                if (browserKeepAliveInterval) {
                    clearInterval(browserKeepAliveInterval);
                    browserKeepAliveInterval = null;
                }
            }
            browserConnectionTimer = null;
        }, 5 * 60 * 1000); // 5 minutos
        
        // Iniciar keepalive (pulso) mientras no haya llamada
        if (browserKeepAliveInterval) clearInterval(browserKeepAliveInterval);
        browserKeepAliveInterval = setInterval(() => {
            if (browserWs && browserWs.readyState === WebSocket.OPEN) {
                browserWs.send(JSON.stringify({ type: 'ping' }));
                console.log('💓 Keepalive enviado al navegador');
            } else {
                if (browserKeepAliveInterval) clearInterval(browserKeepAliveInterval);
                browserKeepAliveInterval = null;
            }
        }, 15000);
        
        initOpenAIToEnglish();

        ws.on('message', (message) => {
            if (openAIWsToEnglish && openAIWsToEnglish.readyState === WebSocket.OPEN) {
                try {
                    const base64Str = message.toString();
                    const ulawBuffer = Buffer.from(base64Str, 'base64');
                    const convertedAudio = twilioToOpenAI(ulawBuffer);
                    
                    openAIWsToEnglish.send(JSON.stringify({
                        type: "session.input_audio_buffer.append",
                        audio: convertedAudio
                    }));
                } catch (err) {
                    console.error("Error al procesar audio del navegador:", err);
                }
            }
        });

        ws.on('close', () => { 
            browserWs = null;
            if (browserKeepAliveInterval) {
                clearInterval(browserKeepAliveInterval);
                browserKeepAliveInterval = null;
            }
            if (browserConnectionTimer) {
                clearTimeout(browserConnectionTimer);
                browserConnectionTimer = null;
            }
            console.log('🔌 Navegador desconectado');
        });
    } 
    
    else if (pathname === '/media-stream') {
        console.log('🚀 Twilio vinculado.');
        twilioWs = ws;
        
        // Matar el keepalive porque la llamada ya va a mantener la conexión viva
        if (browserKeepAliveInterval) {
            clearInterval(browserKeepAliveInterval);
            browserKeepAliveInterval = null;
            console.log('🔄 Keepalive desactivado (llamada iniciada)');
        }
        
        // Matar el timer de espera porque ya hay llamada
        if (browserConnectionTimer) {
            clearTimeout(browserConnectionTimer);
            browserConnectionTimer = null;
            console.log('⏰ Timer de espera cancelado (llamada iniciada)');
        }
        
        initOpenAIToSpanish();

        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                
                if (data.event === 'start') {
                    twilioStreamSid = data.start.streamSid;
                    console.log(`📞 Enlace Twilio fijado: ${twilioStreamSid}`);
                }

                if (data.event === 'media') {
                    twilioPacketsIn++;
                    if (twilioPacketsIn % 100 === 0) {
                        console.log(`📥 [DIAGNÓSTICO]: Procesando audio de Twilio... (${twilioPacketsIn} paquetes)`);
                    }

                    if (openAIWsToSpanish && openAIWsToSpanish.readyState === WebSocket.OPEN) {
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
            console.log('🔌 Twilio desconectado');
        });
    }
});
