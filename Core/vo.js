const logger = require('./logger');
const config = require('../config');
const { readFileSync: read, unlinkSync: remove, writeFileSync: create } = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { tmpdir } = require('os');

class ViewOnceModule {
    constructor(bot) {
        this.bot = bot;
        this.name = 'viewonce';
        
        // Module metadata
        this.metadata = {
            name: 'ViewOnce Handler',
            description: 'Automatically detects and processes ViewOnce messages',
            version: '1.0.0',
            author: 'HyperWa Team',
            category: 'Media Processing',
            dependencies: []
        };

        // Configuration
        this.config = {
            autoForward: config.get('viewonce.autoForward', true),
            saveToTemp: config.get('viewonce.saveToTemp', true),
            tempDir: config.get('viewonce.tempDir', './temp'),
            skipOwner: config.get('viewonce.skipOwner', true),
            logActivity: config.get('viewonce.logActivity', true),
            maxTempAge: config.get('viewonce.maxTempAge', 24 * 60 * 60 * 1000), // 24 hours
            supportedTypes: ['image', 'video', 'audio']
        };

        // Statistics
        this.stats = {
            processed: 0,
            forwarded: 0,
            saved: 0,
            errors: 0,
            startTime: Date.now()
        };

        // Commands that this module provides
        this.commands = [
            {
                name: 'rvo',
                description: 'Manually reveal a ViewOnce message',
                usage: '.rvo (reply to viewonce)',
                permissions: 'public',
                execute: this.handleRvoCommand.bind(this)
            },
            {
                name: 'viewonce',
                description: 'Toggle ViewOnce auto-forward',
                usage: '.viewonce [on/off]',
                permissions: 'admin',
                execute: this.handleViewOnceToggle.bind(this)
            },
            {
                name: 'vostats',
                description: 'Show ViewOnce module statistics',
                usage: '.vostats',
                permissions: 'admin',
                execute: this.handleStatsCommand.bind(this)
            }
        ];

        // Message hooks for automatic processing
        this.messageHooks = {
            'viewonce.detect': this.detectViewOnce.bind(this)
        };

        this.log('ViewOnce module initialized');
    }

    /**
     * Initialize the module
     */
    async init() {
        try {
            // Ensure temp directory exists
            const fs = require('fs');
            if (!fs.existsSync(this.config.tempDir)) {
                fs.mkdirSync(this.config.tempDir, { recursive: true });
            }

            // Start cleanup interval
            setInterval(() => {
                this.cleanTempDirectory();
            }, 60 * 60 * 1000); // Clean every hour

            this.log('ViewOnce module initialized successfully');
        } catch (error) {
            this.logError('Failed to initialize ViewOnce module:', error);
            throw error;
        }
    }

    /**
     * Cleanup when module is destroyed
     */
    async destroy() {
        this.log('ViewOnce module destroyed');
    }

    /**
     * Check if message is a ViewOnce message
     * @param {Object} msg - Message object
     * @returns {boolean}
     */
    isViewOnceMessage(msg) {
        if (!msg || !msg.message) return false;
        
        const message = msg.message;
        return !!(
            message.imageMessage?.viewOnce ||
            message.videoMessage?.viewOnce ||
            message.audioMessage?.viewOnce
        );
    }

    /**
     * Get ViewOnce media type
     * @param {Object} msg - Message object
     * @returns {string|null}
     */
    getViewOnceType(msg) {
        if (!msg || !msg.message) return null;
        
        const message = msg.message;
        if (message.imageMessage?.viewOnce) return 'image';
        if (message.videoMessage?.viewOnce) return 'video';
        if (message.audioMessage?.viewOnce) return 'audio';
        
        return null;
    }

    /**
     * Download ViewOnce media
     * @param {Object} msg - Message object
     * @returns {Promise<Object|null>}
     */
    async downloadViewOnceMedia(msg) {
        try {
            const type = this.getViewOnceType(msg);
            if (!type) return null;

            const mediaMessage = msg.message[`${type}Message`];
            if (!mediaMessage) return null;

            // Download the media
            const buffer = await this.bot.sock.downloadMediaMessage(msg);
            if (!buffer) return null;

            return {
                type,
                buffer,
                mimetype: mediaMessage.mimetype || `${type}/unknown`,
                caption: mediaMessage.caption || '',
                filename: this.generateFilename(type, mediaMessage.mimetype)
            };
        } catch (error) {
            this.logError('Error downloading ViewOnce media:', error);
            return null;
        }
    }

    /**
     * Save media to temp directory
     * @param {Object} mediaData - Media data object
     * @param {string} chatId - Chat ID for context
     * @returns {Promise<string|null>}
     */
    async saveToTemp(mediaData, chatId) {
        try {
            const filename = `viewonce_${Date.now()}_${mediaData.filename}`;
            const filepath = path.join(this.config.tempDir, filename);
            
            create(filepath, mediaData.buffer);
            
            this.stats.saved++;
            this.log(`Saved ViewOnce ${mediaData.type} to temp: ${filename}`);
            
            return filepath;
        } catch (error) {
            this.logError('Error saving to temp:', error);
            return null;
        }
    }

    /**
     * Forward ViewOnce media to the same chat
     * @param {Object} originalMsg - Original message
     * @param {Object} mediaData - Media data
     * @returns {Promise<boolean>}
     */
    async forwardViewOnce(originalMsg, mediaData) {
        try {
            const chatId = originalMsg.key.remoteJid;
            
            let messageContent = {};
            
            switch (mediaData.type) {
                case 'image':
                    messageContent = {
                        image: mediaData.buffer,
                        caption: mediaData.caption || '👁️ ViewOnce Image Revealed',
                        mimetype: mediaData.mimetype
                    };
                    break;
                    
                case 'video':
                    messageContent = {
                        video: mediaData.buffer,
                        caption: mediaData.caption || '👁️ ViewOnce Video Revealed',
                        mimetype: mediaData.mimetype
                    };
                    break;
                    
                case 'audio':
                    // Process audio if needed
                    let audioBuffer = mediaData.buffer;
                    try {
                        audioBuffer = await this.processAudioViewOnce(mediaData.buffer, mediaData.mimetype);
                    } catch (audioError) {
                        this.log('Audio processing failed, using original');
                    }
                    
                    messageContent = {
                        audio: audioBuffer,
                        mimetype: mediaData.mimetype || 'audio/mp4'
                    };
                    break;
                    
                default:
                    return false;
            }

            await this.bot.sock.sendMessage(chatId, messageContent);
            
            this.log(`Forwarded viewonce ${mediaData.type} to ${chatId}`);
            this.stats.forwarded++;
            return true;
        } catch (error) {
            this.logError('Error forwarding viewonce:', error);
            this.stats.errors++;
            return false;
        }
    }

    /**
     * Process audio viewonce (convert if needed)
     * @param {Buffer} audioBuffer - Audio buffer
     * @param {string} mimetype - Original mimetype
     * @returns {Promise<Buffer>}
     */
    async processAudioViewOnce(audioBuffer, mimetype) {
        return new Promise((resolve, reject) => {
            try {
                if (/ogg/.test(mimetype)) {
                    const inputPath = path.join(tmpdir(), `input_${Date.now()}.ogg`);
                    const outputPath = path.join(tmpdir(), `output_${Date.now()}.mp3`);
                    
                    create(inputPath, audioBuffer);
                    
                    exec(`ffmpeg -i ${inputPath} ${outputPath}`, (err) => {
                        remove(inputPath);
                        
                        if (err) {
                            reject(err);
                            return;
                        }
                        
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

    /**
     * Main viewonce detection hook
     * @param {Object} msg - Message object
     * @param {Object} context - Message context
     */
    async detectViewOnce(msg, context) {
        if (!this.isViewOnceMessage(msg)) return;

        const sender = msg.key.participant || msg.key.remoteJid;
        const isOwner = context.isOwner || false;

        if (isOwner && this.config.skipOwner) return;

        await this.processViewOnce(msg, context);
    }

    /**
     * Process viewonce message
     * @param {Object} msg - Message object
     * @param {Object} context - Message context
     */
    async processViewOnce(msg, context) {
        try {
            if (!this.isViewOnceMessage(msg)) return;

            const mediaData = await this.downloadViewOnceMedia(msg);
            if (!mediaData) return;

            // Process audio if needed
            if (mediaData.type === 'audio') {
                try {
                    mediaData.buffer = await this.processAudioViewOnce(mediaData.buffer, mediaData.mimetype);
                } catch (audioError) {
                    this.log('Audio processing failed, using original:', audioError);
                }
            }

            const chatId = msg.key.remoteJid;
            
            // Save to temp if enabled
            let savedPath = null;
            if (this.config.saveToTemp) {
                savedPath = await this.saveToTemp(mediaData, chatId);
            }

            // Forward if enabled
            let forwarded = false;
            if (this.config.autoForward) {
                forwarded = await this.forwardViewOnce(msg, mediaData);
            }

            this.stats.processed++;
            
            this.log(`Processed viewonce ${mediaData.type} from ${chatId}`);

            return {
                success: true,
                mediaData,
                savedPath,
                forwarded,
                timestamp: Date.now()
            };
        } catch (error) {
            this.logError('Error processing viewonce:', error);
            this.stats.errors++;
            return { success: false, error: error.message };
        }
    }

    /**
     * Handle RVO command (manual reveal viewonce)
     * @param {Object} msg - Message object
     * @param {Array} params - Command parameters
     * @param {Object} context - Command context
     */
    async handleRvoCommand(msg, params, context) {
        if (!msg.quoted) {
            return context.bot.sendMessage(context.sender, {
                text: '🔍 *Manual ViewOnce Reveal*\n\n❌ Please reply to a ViewOnce message to reveal it.'
            });
        }

        if (!this.isViewOnceMessage(msg.quoted)) {
            return context.bot.sendMessage(context.sender, {
                text: '❌ The replied message is not a ViewOnce message.'
            });
        }

        const processingMsg = await context.bot.sendMessage(context.sender, {
            text: '⚡ *Revealing ViewOnce*\n\n🔄 Processing ViewOnce message...\n⏳ Please wait...'
        });

        try {
            const result = await this.processViewOnce(msg.quoted, context);
            
            if (result && result.success) {
                await context.bot.sock.sendMessage(context.sender, {
                    text: `✅ *ViewOnce Revealed Successfully*\n\n📦 Type: ${result.mediaData.type}\n📁 Saved: ${result.savedPath ? 'Yes' : 'No'}\n🔄 Forwarded: ${result.forwarded ? 'Yes' : 'No'}\n⏰ ${new Date().toLocaleTimeString()}`,
                    edit: processingMsg.key
                });
            } else {
                await context.bot.sock.sendMessage(context.sender, {
                    text: `❌ *ViewOnce Reveal Failed*\n\n🚫 Error: ${result?.error || 'Unknown error'}\n🔧 Please try again or check the message format.`,
                    edit: processingMsg.key
                });
            }
        } catch (error) {
            logger.error('RVO command failed:', error);
            await context.bot.sendMessage(context.sender, {
                text: `❌ *ViewOnce Reveal Failed*\n\n🚫 Error: ${error.message}`
            });
        }
    }

    /**
     * Handle viewonce toggle command
     * @param {Object} msg - Message object
     * @param {Array} params - Command parameters
     * @param {Object} context - Command context
     */
    async handleViewOnceToggle(msg, params, context) {
        if (params.length === 0) {
            const status = this.config.autoForward ? 'ON' : 'OFF';
            return context.bot.sendMessage(context.sender, {
                text: `🔍 *ViewOnce Auto-Forward Status*\n\n📊 Current Status: ${status}\n\n💡 Usage: \`.viewonce on\` or \`.viewonce off\``
            });
        }

        const action = params[0].toLowerCase();
        
        if (!['on', 'off'].includes(action)) {
            return context.bot.sendMessage(context.sender, {
                text: '❌ Invalid option. Use `on` or `off`.'
            });
        }

        this.config.autoForward = action === 'on';
        
        await context.bot.sendMessage(context.sender, {
            text: `✅ ViewOnce auto-forward has been turned **${action.toUpperCase()}**`
        });
    }

    /**
     * Handle stats command
     * @param {Object} msg - Message object
     * @param {Array} params - Command parameters
     * @param {Object} context - Command context
     */
    async handleStatsCommand(msg, params, context) {
        const uptime = Date.now() - this.stats.startTime;
        const uptimeStr = this.formatUptime(uptime);
        
        const statsText = `📊 *ViewOnce Module Statistics*\n\n` +
            `📈 **Processing Stats:**\n` +
            `• Processed: ${this.stats.processed}\n` +
            `• Forwarded: ${this.stats.forwarded}\n` +
            `• Saved: ${this.stats.saved}\n` +
            `• Errors: ${this.stats.errors}\n\n` +
            `⚙️ **Configuration:**\n` +
            `• Auto-Forward: ${this.config.autoForward ? 'ON' : 'OFF'}\n` +
            `• Save to Temp: ${this.config.saveToTemp ? 'ON' : 'OFF'}\n` +
            `• Skip Owner: ${this.config.skipOwner ? 'ON' : 'OFF'}\n\n` +
            `⏰ **Uptime:** ${uptimeStr}`;

        await context.bot.sendMessage(context.sender, {
            text: statsText
        });
    }

    /**
     * Format uptime duration
     * @param {number} ms - Milliseconds
     * @returns {string}
     */
    formatUptime(ms) {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
        return `${seconds}s`;
    }

    /**
     * Generate filename based on type and mimetype
     * @param {string} type - Media type
     * @param {string} mimetype - MIME type
     * @returns {string}
     */
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

    /**
     * Clean temp directory
     * @param {number} maxAge - Maximum age in milliseconds
     */
    cleanTempDirectory(maxAge = this.config.maxTempAge) {
        try {
            const fs = require('fs');
            if (!fs.existsSync(this.config.tempDir)) return;

            const files = fs.readdirSync(this.config.tempDir);
            const now = Date.now();
            let cleaned = 0;

            files.forEach(file => {
                if (!file.startsWith('viewonce_')) return;

                const filePath = path.join(this.config.tempDir, file);
                try {
                    const stats = fs.statSync(filePath);
                    
                    if (now - stats.mtime.getTime() > maxAge) {
                        fs.unlinkSync(filePath);
                        cleaned++;
                    }
                } catch (error) {
                    // File might have been deleted already
                }
            });

            if (cleaned > 0) {
                this.log(`Cleaned ${cleaned} old viewonce temp files`);
            }
        } catch (error) {
            this.logError('Error cleaning temp directory:', error);
        }
    }

    /**
     * Get module statistics
     * @returns {Object}
     */
    getStats() {
        return {
            ...this.stats,
            tempDir: this.config.tempDir,
            tempDirExists: require('fs').existsSync(this.config.tempDir),
            config: { ...this.config }
        };
    }

    /**
     * Update module configuration
     * @param {Object} newConfig - New configuration
     */
    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
        this.log('Configuration updated:', newConfig);
    }

    /**
     * Log messages
     * @param {...any} args - Arguments to log
     */
    log(...args) {
        if (this.config.logActivity) {
            logger.debug('[ViewOnce]', ...args);
        }
    }

    /**
     * Log errors
     * @param {...any} args - Arguments to log
     */
    logError(...args) {
        logger.error('[ViewOnce]', ...args);
    }
}

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

