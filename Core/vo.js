const { readFileSync: read, unlinkSync: remove, writeFileSync: create } = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { tmpdir } = require('os');

class ViewOnceHandler {
    constructor(client, config = {}) {
        this.client = client;
        this.config = {
            autoForward: config.autoForward ?? true,
            saveToTemp: config.saveToTemp ?? true,
            tempDir: config.tempDir || './temp',
            enableInGroups: config.enableInGroups ?? true,
            enableInPrivate: config.enableInPrivate ?? true,
            logActivity: config.logActivity ?? true,
            ...config
        };
        this.ensureTempDir();
    }

    ensureTempDir() {
        const fs = require('fs');
        if (!fs.existsSync(this.config.tempDir)) {
            fs.mkdirSync(this.config.tempDir, { recursive: true });
        }
    }

    isViewOnceMessage(msg) {
        return !!(
            msg?.message?.viewOnceMessage || 
            msg?.message?.viewOnceMessageV2 || 
            msg?.message?.viewOnceMessageV2Extension ||
            msg?.msg?.viewOnce ||
            (msg?.message && Object.keys(msg.message).some(key =>
                msg.message[key]?.viewOnce === true
            ))
        );
    }

    extractViewOnceContent(msg) {
        try {
            let viewOnceMsg = null;

            if (msg?.message?.viewOnceMessage) {
                viewOnceMsg = msg.message.viewOnceMessage.message;
            } else if (msg?.message?.viewOnceMessageV2) {
                viewOnceMsg = msg.message.viewOnceMessageV2.message;
            } else if (msg?.message?.viewOnceMessageV2Extension) {
                viewOnceMsg = msg.message.viewOnceMessageV2Extension.message;
            } else if (msg?.msg?.viewOnce) {
                viewOnceMsg = msg.message;
            }

            if (!viewOnceMsg) return null;

            const mediaTypes = ['imageMessage', 'videoMessage', 'audioMessage'];
            for (const mediaType of mediaTypes) {
                if (viewOnceMsg[mediaType]) {
                    return {
                        type: mediaType.replace('Message', ''),
                        content: viewOnceMsg[mediaType],
                        caption: viewOnceMsg[mediaType].caption || '',
                        mimetype: viewOnceMsg[mediaType].mimetype || '',
                        originalMessage: msg
                    };
                }
            }

            return null;
        } catch (error) {
            this.log('Error extracting viewonce content:', error);
            return null;
        }
    }

    async downloadViewOnceMedia(msg) {
        try {
            const viewOnceContent = this.extractViewOnceContent(msg);
            if (!viewOnceContent) return null;

            const buffer = await this.client.downloadMediaMessage(viewOnceContent.content);

            if (this.config.logActivity) {
                this.log(`Downloaded viewonce ${viewOnceContent.type} from ${msg.key.remoteJid}`);
            }

            return {
                buffer,
                type: viewOnceContent.type,
                mimetype: viewOnceContent.mimetype,
                caption: viewOnceContent.caption,
                filename: this.generateFilename(viewOnceContent.type, viewOnceContent.mimetype)
            };
        } catch (error) {
            this.log('Error downloading viewonce media:', error);
            return null;
        }
    }

    async saveToTemp(mediaData, chatId) {
        if (!this.config.saveToTemp || !mediaData) return null;

        try {
            const sanitizedChatId = chatId.replace(/[^a-zA-Z0-9]/g, '_');
            const timestamp = Date.now();
            const filename = `viewonce_${sanitizedChatId}_${timestamp}_${mediaData.filename}`;
            const filePath = path.join(this.config.tempDir, filename);

            create(filePath, mediaData.buffer);

            this.log(`Saved viewonce media to: ${filePath}`);
            return filePath;
        } catch (error) {
            this.log('Error saving to temp:', error);
            return null;
        }
    }

    async forwardViewOnce(msg, mediaData) {
        if (!this.config.autoForward || !mediaData) return false;

        try {
            const chatId = msg.key.remoteJid;
            const isGroup = chatId.endsWith('@g.us');

            if (isGroup && !this.config.enableInGroups) return false;
            if (!isGroup && !this.config.enableInPrivate) return false;

            let messageContent = {};
            switch (mediaData.type) {
                case 'image':
                    messageContent = {
                        image: mediaData.buffer,
                        caption: mediaData.caption || '👁️ ViewOnce Image'
                    };
                    break;
                case 'video':
                    messageContent = {
                        video: mediaData.buffer,
                        caption: mediaData.caption || '👁️ ViewOnce Video'
                    };
                    break;
                case 'audio':
                    messageContent = {
                        audio: mediaData.buffer,
                        mimetype: mediaData.mimetype || 'audio/mp4'
                    };
                    break;
                default:
                    return false;
            }

            await this.client.sendMessage(chatId, messageContent);
            this.log(`Forwarded viewonce ${mediaData.type} to ${chatId}`);
            return true;
        } catch (error) {
            this.log('Error forwarding viewonce:', error);
            return false;
        }
    }

    async processAudioViewOnce(audioBuffer, mimetype) {
        return new Promise((resolve, reject) => {
            try {
                if (/ogg/.test(mimetype)) {
                    const inputPath = path.join(tmpdir(), `input_${Date.now()}.ogg`);
                    const outputPath = path.join(tmpdir(), `output_${Date.now()}.mp3`);

                    create(inputPath, audioBuffer);

                    exec(`ffmpeg -i ${inputPath} ${outputPath}`, (err) => {
                        remove(inputPath);

                        if (err) return reject(err);

                        try {
                            const convertedBuffer = read(outputPath);
                            remove(outputPath);
                            resolve(convertedBuffer);
                        } catch (readErr) {
                            reject(readErr);
                        }
                    });
                } else {
                    resolve(audioBuffer);
                }
            } catch (error) {
                reject(error);
            }
        });
    }

    async handleViewOnceMessage(msg) {
        try {
            if (!this.isViewOnceMessage(msg)) return null;

            const sender = msg.key.participant || msg.key.remoteJid;
            const chatId = msg.key.remoteJid;
            const isOwner = this.isOwner ? this.isOwner(sender) : false;

            if (isOwner && this.config.skipOwner) return null;

            const mediaData = await this.downloadViewOnceMedia(msg);
            if (!mediaData) return null;

            if (mediaData.type === 'audio') {
                try {
                    mediaData.buffer = await this.processAudioViewOnce(mediaData.buffer, mediaData.mimetype);
                } catch (err) {
                    this.log('Audio conversion failed:', err);
                }
            }

            let savedPath = null;
            if (this.config.saveToTemp) {
                savedPath = await this.saveToTemp(mediaData, chatId);
            }

            let forwarded = false;
            if (this.config.autoForward) {
                forwarded = await this.forwardViewOnce(msg, mediaData);
            }

            return {
                success: true,
                mediaData,
                savedPath,
                forwarded,
                sender,
                chatId,
                timestamp: Date.now()
            };
        } catch (error) {
            this.log('Error handling viewonce message:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    generateFilename(type, mimetype) {
        const timestamp = Date.now();
        const extensions = {
            'image/jpeg': 'jpg',
            'image/png': 'png',
            'image/webp': 'webp',
            'video/mp4': 'mp4',
            'video/3gpp': '3gp',
            'audio/mp4': 'mp3',
            'audio/ogg': 'ogg',
            'audio/mpeg': 'mp3'
        };
        const ext = extensions[mimetype] || type;
        return `${type}_${timestamp}.${ext}`;
    }

    setOwnerChecker(ownerChecker) {
        this.isOwner = ownerChecker;
    }

    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
    }

    getConfig() {
        return { ...this.config };
    }

    cleanTempDirectory(maxAge = 3600000) {
        try {
            const fs = require('fs');
            const files = fs.readdirSync(this.config.tempDir);
            const now = Date.now();

            files.forEach(file => {
                const filePath = path.join(this.config.tempDir, file);
                const stats = fs.statSync(filePath);
                if (now - stats.mtime.getTime() > maxAge) {
                    fs.unlinkSync(filePath);
                    this.log(`Cleaned old temp file: ${file}`);
                }
            });
        } catch (error) {
            this.log('Error cleaning temp directory:', error);
        }
    }

    log(...args) {
        if (this.config.logActivity) {
            console.log('[ViewOnce]', ...args);
        }
    }

    getStats() {
        return {
            tempDir: this.config.tempDir,
            tempDirExists: require('fs').existsSync(this.config.tempDir),
            config: this.getConfig()
        };
    }
}

// ✅ Export the handler and factories properly
module.exports = {
    ViewOnceHandler,
    createViewOnceHandler: (client, config = {}) => new ViewOnceHandler(client, config),
    setupViewOnceHandler: (client, options = {}) => {
        const handler = new ViewOnceHandler(client, options);
        return async (msg) => {
            if (handler.isViewOnceMessage(msg)) {
                return await handler.handleViewOnceMessage(msg);
            }
            return null;
        };
    }
};
