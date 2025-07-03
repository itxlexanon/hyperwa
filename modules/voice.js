const googleTTS = require('google-tts-api');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

class VoiceModule {
    constructor(bot) {
        this.bot = bot;
        this.name = 'voice';
        this.metadata = {
            description: 'Text to Voice converter',
            version: '1.0.0',
            author: 'You',
            category: 'utility'
        };
        this.commands = [
            {
                name: 'voice',
                description: 'Send voice note from text or reply',
                usage: '.voice <text|number>',
                permissions: 'public',
                ui: {
                    processingText: '🎤 *Generating voice...*',
                    errorText: '❌ *Voice generation failed*'
                },
                execute: this.sendVoice.bind(this)
            }
        ];
    }

    async sendVoice(msg, params, context) {
        const { sock } = this.bot;
        const text = params.join(' ').trim();
        const reply = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const from = msg.key.remoteJid;
        const sender = msg.key.participant || msg.key.remoteJid;

        let toSendJid = from;
        let inputText = text;

        // If replying and no params, use reply text or caption
        if (reply && !text) {
            if (reply.conversation) inputText = reply.conversation;
            else if (reply.extendedTextMessage?.text) inputText = reply.extendedTextMessage.text;
            else if (reply.imageMessage?.caption) inputText = reply.imageMessage.caption;
        }

        // If a phone number is passed (e.g. .voice +123456789)
        if (text.match(/^\+?\d{6,}$/)) {
            toSendJid = text.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
            inputText = 'Hello from your bot!';
        }

        if (!inputText) return '⚠️ *No text provided.*';

        try {
            // Get TTS URL
            const url = googleTTS.getAudioUrl(inputText, {
                lang: 'en',
                slow: false,
                host: 'https://translate.google.com',
            });

            // Download and convert to voice note (OGG/Opus)
            const mp3Path = path.join(__dirname, 'temp_voice.mp3');
            const oggPath = path.join(__dirname, 'temp_voice.ogg');

            const stream = fs.createWriteStream(mp3Path);
            const res = await fetch(url);
            await new Promise((resolve, reject) => {
                res.body.pipe(stream);
                res.body.on('error', reject);
                stream.on('finish', resolve);
            });

            await new Promise((resolve, reject) => {
                ffmpeg(mp3Path)
                    .audioCodec('libopus')
                    .format('ogg')
                    .save(oggPath)
                    .on('end', resolve)
                    .on('error', reject);
            });

            // Send as voice note
            await sock.sendMessage(toSendJid, {
                audio: { url: oggPath },
                mimetype: 'audio/ogg; codecs=opus',
                ptt: true
            }, { quoted: msg });

            // Cleanup
            fs.unlinkSync(mp3Path);
            fs.unlinkSync(oggPath);

            return null; // Message already sent
        } catch (err) {
            console.error('Voice error:', err);
            return '❌ *Failed to generate voice.*';
        }
    }

    async init() {
        console.log('Voice module loaded');
    }

    async destroy() {
        console.log('Voice module unloaded');
    }
}

module.exports = VoiceModule;
