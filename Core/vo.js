const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { tmpdir } = require('os');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');

class ViewOnceHandler {
    constructor(client, config = {}) {
        this.client = client;
        this.config = {
            autoForward: config.autoForward ?? false,
            saveToTemp: config.saveToTemp ?? false,
            tempDir: config.tempDir || './temp',
            enableInGroups: config.enableInGroups ?? true,
            enableInPrivate: config.enableInPrivate ?? true,
            forwardTarget: config.forwardTarget || null
        };
        this.ensureTempDir();
    }

    ensureTempDir() {
        if (!fs.existsSync(this.config.tempDir)) {
            fs.mkdirSync(this.config.tempDir, { recursive: true });
        }
    }

    isViewOnceMessage(msg) {
        try {
            const m = msg?.message;
            if (!m) return false;
            return (
                m?.viewOnceMessage ||
                m?.viewOnceMessageV2 ||
                m?.viewOnceMessageV2Extension ||
                Object.values(m).some(v => v?.viewOnce === true)
            );
        } catch {
            return false;
        }
    }

    extractViewOnceContent(msg) {
        let viewOnceMsg = msg?.message?.viewOnceMessage?.message ||
                          msg?.message?.viewOnceMessageV2?.message ||
                          msg?.message?.viewOnceMessageV2Extension?.message;

        if (!viewOnceMsg) return null;

        const types = ['imageMessage', 'videoMessage', 'audioMessage'];
        for (const type of types) {
            if (viewOnceMsg[type]) {
                return {
                    type: type.replace('Message', ''),
                    content: viewOnceMsg[type],
                    caption: viewOnceMsg[type]?.caption || '',
                    mimetype: viewOnceMsg[type]?.mimetype || ''
                };
            }
        }

        return null;
    }

    async downloadViewOnceMedia(msg) {
        const viewOnceContent = this.extractViewOnceContent(msg);
        if (!viewOnceContent) return null;

        // Construct a fake message to make Baileys happy
        const fakeMsg = {
            key: msg.key,
            message: {
                [`${viewOnceContent.type}Message`]: viewOnceContent.content
            }
        };

        try {
            const buffer = await downloadMediaMessage(fakeMsg, 'buffer', {});
            return {
                ...viewOnceContent,
                buffer,
                filename: this.generateFilename(viewOnceContent.type, viewOnceContent.mimetype)
            };
        } catch (error) {
            console.error('❌ Failed to download view-once media:', error);
            return null;
        }
    }

    async forwardViewOnce(msg, mediaData) {
        if (!this.config.autoForward || !mediaData) return false;

        const target = this.config.forwardTarget || msg.key.remoteJid;
        const isGroup = target.endsWith('@g.us');
        if (isGroup && !this.config.enableInGroups) return false;
        if (!isGroup && !this.config.enableInPrivate) return false;

        const content = {};
        if (mediaData.type === 'image') {
            content.image = mediaData.buffer;
            content.caption = mediaData.caption || '👁️ ViewOnce Image';
        } else if (mediaData.type === 'video') {
            content.video = mediaData.buffer;
            content.caption = mediaData.caption || '🎥 ViewOnce Video';
        } else if (mediaData.type === 'audio') {
            content.audio = mediaData.buffer;
            content.mimetype = mediaData.mimetype || 'audio/mp4';
        }

        try {
            await this.client.sendMessage(target, content);
            return true;
        } catch (error) {
            console.error('❌ Failed to forward view-once:', error);
            return false;
        }
    }

    async saveToTemp(mediaData) {
        if (!this.config.saveToTemp || !mediaData) return null;

        const filePath = path.join(this.config.tempDir, mediaData.filename);
        try {
            fs.writeFileSync(filePath, mediaData.buffer);
            return filePath;
        } catch (err) {
            console.error('❌ Failed to save to temp:', err);
            return null;
        }
    }

    async processAudio(mediaData) {
        const inputPath = path.join(tmpdir(), `input-${Date.now()}.ogg`);
        const outputPath = path.join(tmpdir(), `output-${Date.now()}.mp3`);

        fs.writeFileSync(inputPath, mediaData.buffer);

        return new Promise((resolve, reject) => {
            exec(`ffmpeg -i "${inputPath}" -vn -ar 44100 -ac 2 -b:a 128k "${outputPath}"`, (err) => {
                fs.unlinkSync(inputPath);
                if (err) return reject(err);

                const mp3Buffer = fs.readFileSync(outputPath);
                fs.unlinkSync(outputPath);
                resolve(mp3Buffer);
            });
        });
    }

    async handleViewOnceMessage(msg) {
        try {
            if (!this.isViewOnceMessage(msg)) return null;

            const mediaData = await this.downloadViewOnceMedia(msg);
            if (!mediaData) return null;

            if (mediaData.type === 'audio') {
                mediaData.buffer = await this.processAudio(mediaData);
            }

            const savedPath = await this.saveToTemp(mediaData);
            await this.forwardViewOnce(msg, mediaData);

            return {
                success: true,
                mediaData,
                savedPath
            };
        } catch (error) {
            console.error('❌ Error handling view-once message:', error);
            return { success: false, error };
        }
    }

    generateFilename(type, mimetype) {
        const extMap = {
            'image/jpeg': 'jpg',
            'image/png': 'png',
            'image/webp': 'webp',
            'video/mp4': 'mp4',
            'audio/ogg': 'ogg',
            'audio/mpeg': 'mp3',
            'audio/mp4': 'mp3'
        };
        const ext = extMap[mimetype] || type;
        return `vo-${Date.now()}.${ext}`;
    }

    updateConfig(config) {
        this.config = { ...this.config, ...config };
    }

    getStats() {
        return {
            ...this.config,
            tempDirExists: fs.existsSync(this.config.tempDir)
        };
    }
}

module.exports = {
    ViewOnceHandler,
    createViewOnceHandler: (client, config) => new ViewOnceHandler(client, config),
    setupViewOnceHandler: (client, config) => {
        const handler = new ViewOnceHandler(client, config);
        return async (msg) => {
            if (handler.isViewOnceMessage(msg)) {
                return await handler.handleViewOnceMessage(msg);
            }
            return null;
        };
    }
};
