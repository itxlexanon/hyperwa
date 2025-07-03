const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

class VoiceModule {
    constructor(bot) {
        this.bot = bot;
        this.name = 'voice';
        this.metadata = {
            description: 'Convert any audio/video reply to voice note',
            version: '1.1.0',
            author: 'ChatGPT',
            category: 'media'
        };
        this.commands = [
            {
                name: 'voice',
                description: 'Send replied media as a voice note',
                usage: '.voice (reply to any audio/video)',
                permissions: 'public',
                ui: {
                    processingText: '🎙️ *Converting media to voice...*',
                    errorText: '❌ *Failed to convert media to voice note.*'
                },
                execute: this.sendVoice.bind(this)
            }
        ];
    }

    async sendVoice(msg, params, context) {
        try {
            const quoted = msg.quoted;
            if (!quoted || !quoted.message) {
                return '❗️Please reply to an audio, voice, or video message.';
            }

            // Detect valid media types
            const validTypes = ['audioMessage', 'videoMessage', 'documentMessage'];
            const mediaType = validTypes.find(type => quoted.message[type]);
            if (!mediaType) return '❗️Unsupported media. Please reply to a voice, audio, or video.';

            // Create temp folder if not exists
            const mediaPath = path.join(__dirname, '..', 'temp');
            if (!fs.existsSync(mediaPath)) fs.mkdirSync(mediaPath);

            // Prepare file paths
            const inputFile = path.join(mediaPath, `input_${Date.now()}.media`);
            const outputFile = path.join(mediaPath, `voice_${Date.now()}.ogg`);

            // Download media stream
            const stream = await this.bot.wa.downloadMediaMessage(quoted);
            const writeStream = fs.createWriteStream(inputFile);
            stream.pipe(writeStream);

            await new Promise((resolve, reject) => {
                writeStream.on('finish', resolve);
                writeStream.on('error', reject);
            });

            // Convert using ffmpeg to voice note format (opus)
            await new Promise((resolve, reject) => {
                ffmpeg(inputFile)
                    .audioCodec('libopus')
                    .audioFrequency(48000)
                    .audioBitrate('96k')
                    .format('opus')
                    .save(outputFile)
                    .on('end', resolve)
                    .on('error', reject);
            });

            // Send as voice note
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

            return false; // skip bot reply message
        } catch (err) {
            console.error('VoiceModule Error:', err);
            return '❌ Failed to convert media to voice note.';
        }
    }

    async init() {
        console.log('[🎤] Voice module loaded');
    }

    async destroy() {
        console.log('[🛑] Voice module unloaded');
    }
}

module.exports = VoiceModule;
