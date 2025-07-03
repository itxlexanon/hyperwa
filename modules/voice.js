const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');

class VoiceModule {
    constructor(bot) {
        this.bot = bot;
        this.name = 'voice';
        this.metadata = {
            description: 'Convert replied audio/video to voice note',
            version: '1.0.0',
            author: 'You',
            category: 'media'
        };
        this.commands = [
            {
                name: 'voice',
                description: 'Convert replied audio/video to voice note',
                usage: '.voice',
                permissions: 'public',
                ui: {
                    processingText: '🎙 Generating voice note...',
                    errorText: '❌ Failed to convert to voice note.'
                },
                execute: this.sendVoice.bind(this)
            }
        ];
    }

    async sendVoice(msg, params, context) {
        try {
            const quoted = msg.quoted;
            if (!quoted || !quoted.message) {
                return '❗️Please reply to a voice, audio, or video message.';
            }

            const rawTypes = Object.keys(quoted.message);
            console.log('📥 Replied message type(s):', rawTypes);

            let mediaBuffer = null;
            let mediaMime = null;

            if (quoted.message.audioMessage || quoted.message.voiceNoteMessage) {
                mediaBuffer = await this.bot.wa.downloadMediaMessage(quoted);
                mediaMime = 'audio';
            } else if (quoted.message.videoMessage) {
                mediaBuffer = await this.bot.wa.downloadMediaMessage(quoted);
                mediaMime = 'video';
            } else if (quoted.message.documentMessage && quoted.message.documentMessage.mimetype?.startsWith('audio')) {
                mediaBuffer = await this.bot.wa.downloadMediaMessage(quoted);
                mediaMime = 'document-audio';
            }

            if (!mediaBuffer) {
                return '❗️Unsupported or missing media. Reply to an audio, voice, video, or audio document.';
            }

            const mediaPath = path.join(__dirname, '..', 'temp');
            if (!fs.existsSync(mediaPath)) fs.mkdirSync(mediaPath);

            const inputFile = path.join(mediaPath, `input_${Date.now()}.media`);
            const outputFile = path.join(mediaPath, `voice_${Date.now()}.ogg`);

            fs.writeFileSync(inputFile, mediaBuffer);

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

            await this.bot.wa.sendMessage(msg.chat, {
                audio: fs.readFileSync(outputFile),
                mimetype: 'audio/ogg; codecs=opus',
                ptt: true
            }, {
                quoted: msg.key
            });

            fs.unlinkSync(inputFile);
            fs.unlinkSync(outputFile);

            return false;
        } catch (err) {
            console.error('❌ Voice conversion error:', err);
            return '❌ Failed to convert to voice note.';
        }
    }

    async init() {
        console.log('✅ Voice module initialized');
    }

    async destroy() {
        console.log('🛑 Voice module unloaded');
    }
}

module.exports = VoiceModule;
