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

const server = app.listen(PORT, () => console.log(`Servidor de traducción diagnóstica corriendo en puerto ${PORT}`));
const wss = new WebSocket.Server({ server });

let openAIWsToEnglish = null; 
let openAIWsToSpanish = null; 

let twilioWs = null;
let browserWs = null;
let twilioStreamSid = null;

// CONTADORES DE DIAGNÓSTICO (Para saber si viaja audio binario)
let browserPacketsIn = 0;
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
        // Si tu navegador envía PCM tradicional, le especificamos el formato por defecto
        openAIWsToEnglish.send(JSON.stringify({
            type: "session.update",
            session: { 
                audio: { output: { language: "en" } }
            }
        }));
    });

    openAIWsToEnglish.on('message', (message) => {
        try {
            const response = JSON.parse(message);
            if (response.type === 'error') console.error('❌ [ERROR OPENAI EN]:', response.error);

            // DIAGNÓSTICO DE TEXTO: ¿Qué está entendiendo OpenAI de tu micrófono?
            if (response.type === 'session.input_transcript.delta') {
                process.stdout.write(`🎙️ [Tu Micrófono dice]: ${response.delta}\n`);
            }
            if (response.type === 'session.output_transcript.delta') {
                process.stdout.write(`🇺🇸 [Traducción al Inglés generada]: ${response.delta}\n`);
            }

            // Flujo de audio hacia Twilio
            if (response.type === 'session.output_audio.delta' && response.delta) {
                if (twilioWs && twilioWs.readyState === WebSocket.OPEN && twilioStreamSid) {
                    twilioWs.send(JSON.stringify({ 
                        event: "media", 
                        streamSid: twilioStreamSid, 
                        media: { payload: response.delta } 
                    }));
                }
            }
        } catch (e) {
            console.error("Error en mensaje Canal Inglés:", e);
        }
    });

    openAIWsToEnglish.on('close', () => { console.log('🔌 Canal Inglés Cerrado.'); openAIWsToEnglish = null; });
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
        // Intentamos indicarle a OpenAI que el teléfono le enviará y esperará G711 Ulaw
        openAIWsToSpanish.send(JSON.stringify({
            type: "session.update",
            session: { 
                input_audio_format: "g711_ulaw",
                output_audio_format: "g711_ulaw",
                audio: { output: { language: "es" } } 
            }
        }));
    });

    openAIWsToSpanish.on('message', (message) => {
        try {
            const response = JSON.parse(message);
            if (response.type === 'error') console.error('❌ [ERROR OPENAI ES]:', response.error);

            // DIAGNÓSTICO DE TEXTO: ¿Qué está entendiendo OpenAI del teléfono?
            if (response.type === 'session.input_transcript.delta') {
                process.stdout.write(`📞 [El Teléfono dice]: ${response.delta}\n`);
            }
            if (response.type === 'session.output_transcript.delta') {
                process.stdout.write(`🇪🇸 [Traducción al Español generada]: ${response.delta}\n`);
            }

            // Flujo de audio hacia tu Navegador
            if (response.type === 'session.output_audio.delta' && response.delta) {
                if (browserWs && browserWs.readyState === WebSocket.OPEN) {
                    browserWs.send(JSON.stringify({ type: 'audio', payload: response.delta }));
                }
            }
        } catch (e) {
            console.error("Error en mensaje Canal Español:", e);
        }
    });

    openAIWsToSpanish.on('close', () => { console.log('🔌 Canal Español Cerrado.'); openAIWsToSpanish = null; });
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
            browserPacketsIn++;
            // Imprime un reporte cada 100 ráfagas de audio para no saturar la pantalla
            if (browserPacketsIn % 100 === 0) {
                console.log(`📥 [DIAGNÓSTICO]: Capturando audio del navegador... (${browserPacketsIn} paquetes recibidos)`);
            }

            if (openAIWsToEnglish && openAIWsToEnglish.readyState === WebSocket.OPEN) {
                openAIWsToEnglish.send(JSON.stringify({
                    type: "session.input_audio_buffer.append",
                    audio: message.toString('base64') // Forzamos codificación limpia base64 por si viene crudo
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
                        console.log(`📥 [DIAGNÓSTICO]: Capturando audio del Teléfono... (${twilioPacketsIn} paquetes recibidos)`);
                    }

                    if (openAIWsToSpanish && openAIWsToSpanish.readyState === WebSocket.OPEN) {
                        openAIWsToSpanish.send(JSON.stringify({
                            type: "session.input_audio_buffer.append",
                            audio: data.media.payload
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
