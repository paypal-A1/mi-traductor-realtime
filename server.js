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
let callStartTime = null;

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

// CONVERSOR 1: Teléfono/Navegador (8kHz u-law) ➡️ OpenAI (24kHz PCM16)
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

// CONVERSOR 2: OpenAI (24kHz PCM16) ➡️ Teléfono/Navegador (8kHz u-law)
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

// ==================== DESCARGA DE CONVERSACIÓN ====================
let conversacionTemporal = [];
let bufferProveedor = '';
let bufferTu = '';
let ultimoTipo = null;

function guardarFragmento(tipo, fragmento) {
    if (tipo === 'proveedor') {
        bufferProveedor += fragmento;
        if (/[.!?;:]\s*$/.test(bufferProveedor)) {
            conversacionTemporal.push({
                timestamp: new Date().toISOString(),
                tipo: 'proveedor',
                texto: bufferProveedor.trim()
            });
            bufferProveedor = '';
        }
    } else if (tipo === 'tu') {
        bufferTu += fragmento;
        if (/[.!?;:]\s*$/.test(bufferTu)) {
            conversacionTemporal.push({
                timestamp: new Date().toISOString(),
                tipo: 'tu',
                texto: bufferTu.trim()
            });
            bufferTu = '';
        }
    }
}

function finalizarConversacion() {
    // Guardar lo que quede del proveedor
    if (bufferProveedor && bufferProveedor.trim().length > 0) {
        conversacionTemporal.push({
            timestamp: new Date().toISOString(),
            tipo: 'proveedor',
            texto: bufferProveedor.trim()
        });
    }
    // Guardar lo que quede del usuario (tú)
    if (bufferTu && bufferTu.trim().length > 0) {
        conversacionTemporal.push({
            timestamp: new Date().toISOString(),
            tipo: 'tu',
            texto: bufferTu.trim()
        });
    }
    // Limpiar siempre
    bufferProveedor = '';
    bufferTu = '';
}

app.get('/descargar-conversacion', (req, res) => {
    finalizarConversacion();
    
    if (conversacionTemporal.length === 0) {
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', 'attachment; filename="conversacion_vacia.txt"');
        return res.send("No hay conversación registrada.");
    }
    
    let contenido = '';
    for (const linea of conversacionTemporal) {
        const hora = new Date(linea.timestamp).toLocaleTimeString([], { hour: '2-digit', minute:'2-digit', second:'2-digit' });
        if (linea.tipo === 'tu') {
            contenido += `[${hora}] Tú: ${linea.texto}\n`;
        } else if (linea.tipo === 'proveedor') {
            contenido += `[${hora}] Proveedor: ${linea.texto}\n`;
        }
    }
    
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', 'attachment; filename="conversacion.txt"');
    res.send(contenido);
    
    conversacionTemporal = [];
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
        callStartTime = Date.now();
        
        conversacionTemporal = [];
        bufferProveedor = '';
        bufferTu = '';
        ultimoTipo = null;
        
        res.status(200).json({ success: true, callSid: call.sid });
    } catch (error) {
        console.error('Error al realizar la llamada:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/hangup', async (req, res) => {
    try {
        if (activeCallSid) {
            // 1. Cerrar llamada en Twilio
            await client.calls(activeCallSid).update({ status: 'completed' });
            
            // 2. Finalizar conversación para guardar lo que falta
            finalizarConversacion();
            
            // 3. CERRAR SESIONES DE OPENAI INMEDIATAMENTE (para que no sigan enviando audio)
            if (openAIWsToEnglish && openAIWsToEnglish.readyState === WebSocket.OPEN) {
                openAIWsToEnglish.send(JSON.stringify({ type: "session.close" }));
                setTimeout(() => {
                    if (openAIWsToEnglish) openAIWsToEnglish.close();
                    openAIWsToEnglish = null;
                }, 100);
            }
            if (openAIWsToSpanish && openAIWsToSpanish.readyState === WebSocket.OPEN) {
                openAIWsToSpanish.send(JSON.stringify({ type: "session.close" }));
                setTimeout(() => {
                    if (openAIWsToSpanish) openAIWsToSpanish.close();
                    openAIWsToSpanish = null;
                }, 100);
            }
            
            // 4. Calcular duración y RAM
            const duracion = callStartTime ? ((Date.now() - callStartTime) / 1000).toFixed(1) : 'desconocida';
            const memUsage = process.memoryUsage();
            console.log(`📊 [RAM] Llamada finalizada. Duración: ${duracion}s | RSS: ${(memUsage.rss / 1024 / 1024).toFixed(1)} MB | Heap: ${(memUsage.heapUsed / 1024 / 1024).toFixed(1)} MB`);
            
            // 5. Notificar al navegador la duración
            browserConnections.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'call_duration', duration: duracion }));
                }
            });
            
            activeCallSid = null;
            callStartTime = null;
            res.status(200).json({ success: true });
        } else {
            res.status(400).json({ success: false, error: "No hay llamada activa" });
        }
    } catch (error) {
        console.error('Error al colgar:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});
// ================================================================

const server = app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
const wss = new WebSocket.Server({ server });

let openAIWsToEnglish = null;
let openAIWsToSpanish = null;
let twilioWs = null;
let twilioStreamSid = null;
let twilioPacketsIn = 0;
let ultimoOriginalIngles = '';

const browserConnections = new Set();

function broadcastToBrowsers(audioData) {
    const toRemove = [];
    browserConnections.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'audio', payload: audioData }));
        } else {
            toRemove.push(ws);
        }
    });
    toRemove.forEach(ws => browserConnections.delete(ws));
}

function initOpenAIToEnglish() {
    if (openAIWsToEnglish && openAIWsToEnglish.readyState === WebSocket.OPEN) return;

    console.log('Conectando a OpenAI [Canal Español ➡️ Inglés]... 🇺🇸');
    
    openAIWsToEnglish = new WebSocket('wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate', {
        headers: {
            "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
            "OpenAI-Safety-Identifier": "traductor-to-english-prod"
        }
    });

    let ultimoEspanol = ''; // Variable local para guardar lo que dices en español

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

            // Capturamos lo que dices en español (original)
            if (response.type === 'session.input_transcript.delta') {
                ultimoEspanol = response.delta;
                process.stdout.write(`🎙️ [Tu Micrófono dice]: ${ultimoEspanol}\n`);
            }
            
            // Cuando llega la traducción al inglés, guardamos el español original
            if (response.type === 'session.output_transcript.delta') {
                const traduccionIngles = response.delta;
                process.stdout.write(`🇺🇸 [Traducción al Inglés generada]: ${traduccionIngles}\n`);
                
                if (ultimoEspanol) {
                    // Guardas lo que dijiste en español (original)
                    guardarFragmento('tu', ultimoEspanol);
                    ultimoEspanol = '';
                } else {
                    // Fallback: si no hay original, guardas la traducción
                    guardarFragmento('tu', traduccionIngles);
                }
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
            
            if (response.type === 'session.closed') {
                console.log('✅ Sesión OpenAI [Inglés] cerrada limpiamente');
                if (openAIWsToEnglish) {
                    openAIWsToEnglish.close();
                    openAIWsToEnglish = null;
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
            session: { audio: { output: { language: "es" } } }
        }));
    });

    openAIWsToSpanish.on('message', (message) => {
        try {
            const response = JSON.parse(message);
            if (response.type === 'error') console.error('❌ [ERROR OPENAI ES]:', response.error);

            if (response.type === 'session.input_transcript.delta') {
                process.stdout.write(`📞 [El Teléfono dice]: ${response.delta}\n`);
                ultimoOriginalIngles = response.delta;
            }
            if (response.type === 'session.output_transcript.delta') {
                const texto = response.delta;
                process.stdout.write(`🇪🇸 [Traducción al Español generada]: ${texto}\n`);
                if (ultimoOriginalIngles) {
                    guardarFragmento('proveedor', `${texto} (${ultimoOriginalIngles})`);
                    ultimoOriginalIngles = '';
                } else {
                    guardarFragmento('proveedor', texto);
                }
            }

            if (response.type === 'session.output_audio.delta' && response.delta) {
                console.log(`🔊 [AUDIO -> NAVEGADOR]: Reenviando paquete de voz traducido al Español.`);
                const convertedAudio = openAIToTwilio(response.delta);
                console.log(`📊 Longitud del audio convertido: ${convertedAudio.length} caracteres base64`);
                broadcastToBrowsers(convertedAudio);
                console.log(`✅ Audio enviado a todos los navegadores conectados`);
            }
            
            // CAMBIO 1: session.closed
            if (response.type === 'session.closed') {
                console.log('✅ Sesión OpenAI [Español] cerrada limpiamente');
                if (openAIWsToSpanish) {
                    openAIWsToSpanish.close();
                    openAIWsToSpanish = null;
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
        console.log('🚀 Navegador conectado. Total conexiones activas:', browserConnections.size + 1);
        browserConnections.add(ws);
        
        const keepAliveInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'ping' }));
                console.log('💓 Keepalive enviado al navegador');
            } else {
                clearInterval(keepAliveInterval);
            }
        }, 10000);
        
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
            browserConnections.delete(ws);
            clearInterval(keepAliveInterval);
            console.log('🔌 Navegador desconectado. Conexiones restantes:', browserConnections.size);
        });
        
        ws.on('error', (err) => {
            console.error('Error en WebSocket del navegador:', err.message);
            browserConnections.delete(ws);
            clearInterval(keepAliveInterval);
        });
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
                    console.log(`📞 Enlace Twilio fijado: ${twilioStreamSid}`);
                    
                    // CAMBIO 2: Notificar al navegador que puede activar el micrófono
                    browserConnections.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({ type: 'twilio_ready' }));
                            console.log('📢 Notificado al navegador: Twilio listo');
                        }
                    });
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
