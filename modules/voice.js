const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

class VoiceModule {
    constructor(bot) {
        this.bot = bot;
        this.name = 'voice';
        this.metadata = {
            description: 'Reply with voice note from replied audio',
            version: '1.0.0',
            author: 'ChatGPT',
            category: 'media'
        };
        this.commands = [
            {
                name: 'voice',
                description: 'Send replied audio as a voice note',
                usage: '.voice (reply to audio)',
                permissions: 'public',
                ui: {
                    processingText: '🎙️ *Generating voice...*',
                    errorText: '❌ *Voice generation failed.*'
                },
                execute: this.sendVoice.bind(this)
            }
        ];
    }

    async sendVoice(msg, params, context) {
        try {
            const quoted = msg.quoted;

            if (!quoted || !quoted.message || !quoted.message.audioMessage) {
                return '❗️Please reply to an audio message.';
            }

            const mediaPath = path.join(__dirname, '..', 'temp');
            if (!fs.existsSync(mediaPath)) fs.mkdirSync(mediaPath);

            const inputFile = path.join(mediaPath, `input_${Date.now()}.ogg`);
            const outputFile = path.join(mediaPath, `voice_${Date.now()}.ogg`);

            // Download audio message
            const stream = await this.bot.wa.downloadMediaMessage(quoted);
            const writeStream = fs.createWriteStream(inputFile);
            stream.pipe(writeStream);

            // Wait for download to finish
            await new Promise((resolve, reject) => {
                writeStream.on('finish', resolve);
                writeStream.on('error', reject);
            });

            // Convert to WhatsApp-compatible voice note
            await new Promise((resolve, reject) => {
                ffmpeg(inputFile)
                    .audioCodec('libopus')
                    .audioFilters('volume=1.0')
                    .format('opus')
                    .save(outputFile)
                    .on('end', resolve)
                    .on('error', reject);
            });

            // Send as voice note (PTT = true)
            await this.bot.wa.sendMessage(msg.chat, {
                audio: fs.readFileSync(outputFile),
                mimetype: 'audio/ogg; codecs=opus',
                ptt: true
            }, {
                quoted: msg.key
            });

            // Clean up
            fs.unlinkSync(inputFile);
            fs.unlinkSync(outputFile);

            return false; // Prevent showing final success message
        } catch (err) {
            console.error('Voice error:', err);
            return '❌ Failed to generate voice note.';
        }
    }

    async init() {
        console.log('[✅] Voice module initialized');
    }

    async destroy() {
        console.log('[❌] Voice module destroyed');
    }
}

module.exports = VoiceModule;
