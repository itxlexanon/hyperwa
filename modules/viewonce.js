const { readFileSync: read, unlinkSync: remove, writeFileSync: create } = require('fs')
const path = require('path')
const { exec } = require('child_process')
const { tmpdir } = require('os')
const logger = require('./logger')

class ViewOnceModule {
    constructor(bot) {
        this.bot = bot
        this.name = 'viewonce'
        this.metadata = {
            description: 'ViewOnce message detection and download module',
            version: '1.0.0',
            author: 'ViewOnce Handler',
            category: 'Media Processing',
            dependencies: []
        }
        
        this.config = {
            autoForward: true,
            saveToTemp: true,
            tempDir: './temp',
            enableInGroups: true,
            enableInPrivate: true,
            logActivity: true,
            skipOwner: false,
            maxTempAge: 3600000 // 1 hour
        }

        this.commands = [
            {
                name: 'rvo',
                description: 'Manually reveal viewonce message',
                usage: '.rvo (reply to viewonce)',
                permissions: 'public',
                execute: this.handleRvoCommand.bind(this)
            },
            {
                name: 'viewonce',
                description: 'Toggle viewonce auto-forward',
                usage: '.viewonce on/off',
                permissions: 'admin',
                execute: this.handleViewOnceToggle.bind(this)
            }
        ]

        this.messageHooks = {
            'viewonce.detect': this.detectViewOnce.bind(this),
            'viewonce.process': this.processViewOnce.bind(this)
        }

        this.stats = {
            processed: 0,
            forwarded: 0,
            saved: 0,
            errors: 0
        }
    }

    async init() {
        logger.info('🔍 ViewOnce Module initialized')
        this.ensureTempDir()
        this.startCleanupInterval()
    }

    async destroy() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval)
        }
        logger.info('🔍 ViewOnce Module destroyed')
    }

    /**
     * Ensure temp directory exists
     */
    ensureTempDir() {
        const fs = require('fs')
        if (!fs.existsSync(this.config.tempDir)) {
            fs.mkdirSync(this.config.tempDir, { recursive: true })
        }
    }

    /**
     * Start cleanup interval for temp files
     */
    startCleanupInterval() {
        this.cleanupInterval = setInterval(() => {
            this.cleanTempDirectory()
        }, 600000) // Clean every 10 minutes
    }

    /**
     * Check if message is a viewonce message
     * @param {Object} msg - Message object
     * @returns {boolean}
     */
    isViewOnceMessage(msg) {
        return !!(msg?.message?.viewOnceMessage || 
                 msg?.message?.viewOnceMessageV2 || 
                 msg?.message?.viewOnceMessageV2Extension ||
                 msg?.msg?.viewOnce ||
                 (msg?.message && Object.keys(msg.message).some(key => 
                     msg.message[key]?.viewOnce === true
                 )))
    }

    /**
     * Extract viewonce message content
     * @param {Object} msg - Message object
     * @returns {Object|null}
     */
    extractViewOnceContent(msg) {
        try {
            let viewOnceMsg = null
            
            if (msg?.message?.viewOnceMessage) {
                viewOnceMsg = msg.message.viewOnceMessage.message
            } else if (msg?.message?.viewOnceMessageV2) {
                viewOnceMsg = msg.message.viewOnceMessageV2.message
            } else if (msg?.message?.viewOnceMessageV2Extension) {
                viewOnceMsg = msg.message.viewOnceMessageV2Extension.message
            } else if (msg?.msg?.viewOnce) {
                viewOnceMsg = msg.message
            }

            if (!viewOnceMsg) return null

            const mediaTypes = ['imageMessage', 'videoMessage', 'audioMessage']
            
            for (const mediaType of mediaTypes) {
                if (viewOnceMsg[mediaType]) {
                    return {
                        type: mediaType.replace('Message', ''),
                        content: viewOnceMsg[mediaType],
                        caption: viewOnceMsg[mediaType].caption || '',
                        mimetype: viewOnceMsg[mediaType].mimetype || '',
                        originalMessage: msg
                    }
                }
            }

            return null
        } catch (error) {
            this.logError('Error extracting viewonce content:', error)
            return null
        }
    }

    /**
     * Download viewonce media
     * @param {Object} msg - Message object
     * @returns {Promise<Object|null>}
     */
    async downloadViewOnceMedia(msg) {
        try {
            const viewOnceContent = this.extractViewOnceContent(msg)
            if (!viewOnceContent) return null

            const buffer = await this.bot.sock.downloadMediaMessage(viewOnceContent.content)
            
            this.log(`Downloaded viewonce ${viewOnceContent.type} from ${msg.key.remoteJid}`)

            return {
                buffer,
                type: viewOnceContent.type,
                mimetype: viewOnceContent.mimetype,
                caption: viewOnceContent.caption,
                filename: this.generateFilename(viewOnceContent.type, viewOnceContent.mimetype)
            }
        } catch (error) {
            this.logError('Error downloading viewonce media:', error)
            this.stats.errors++
            return null
        }
    }

    /**
     * Save viewonce media to temp directory
     * @param {Object} mediaData - Media data
     * @param {string} chatId - Chat ID
     * @returns {Promise<string|null>}
     */
    async saveToTemp(mediaData, chatId) {
        if (!this.config.saveToTemp || !mediaData) return null

        try {
            const sanitizedChatId = chatId.replace(/[^a-zA-Z0-9]/g, '_')
            const timestamp = Date.now()
            const filename = `viewonce_${sanitizedChatId}_${timestamp}_${mediaData.filename}`
            const filePath = path.join(this.config.tempDir, filename)

            create(filePath, mediaData.buffer)
            
            this.log(`Saved viewonce media to: ${filePath}`)
            this.stats.saved++
            return filePath
        } catch (error) {
            this.logError('Error saving to temp:', error)
            this.stats.errors++
            return null
        }
    }

    /**
     * Forward viewonce media to same chat
     * @param {Object} msg - Original message
     * @param {Object} mediaData - Media data
     * @returns {Promise<boolean>}
     */
    async forwardViewOnce(msg, mediaData) {
        if (!this.config.autoForward || !mediaData) return false

        try {
            const chatId = msg.key.remoteJid
            const isGroup = chatId.endsWith('@g.us')
            
            if (isGroup && !this.config.enableInGroups) return false
            if (!isGroup && !this.config.enableInPrivate) return false

            let messageContent = {}
            
            switch (mediaData.type) {
                case 'image':
                    messageContent = {
                        image: mediaData.buffer,
                        caption: mediaData.caption || '👁️ ViewOnce Image'
                    }
                    break
                    
                case 'video':
                    messageContent = {
                        video: mediaData.buffer,
                        caption: mediaData.caption || '👁️ ViewOnce Video'
                    }
                    break
                    
                case 'audio':
                    messageContent = {
                        audio: mediaData.buffer,
                        mimetype: mediaData.mimetype || 'audio/mp4'
                    }
                    break
                    
                default:
                    return false
            }

            await this.bot.sock.sendMessage(chatId, messageContent)
            
            this.log(`Forwarded viewonce ${mediaData.type} to ${chatId}`)
            this.stats.forwarded++
            return true
        } catch (error) {
            this.logError('Error forwarding viewonce:', error)
            this.stats.errors++
            return false
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
                    const inputPath = path.join(tmpdir(), `input_${Date.now()}.ogg`)
                    const outputPath = path.join(tmpdir(), `output_${Date.now()}.mp3`)
                    
                    create(inputPath, audioBuffer)
                    
                    exec(`ffmpeg -i ${inputPath} ${outputPath}`, (err) => {
                        remove(inputPath)
                        
                        if (err) {
                            reject(err)
                            return
                        }
                        
                        try {
                            const convertedBuffer = read(outputPath)
                            remove(outputPath)
                            resolve(convertedBuffer)
                        } catch (readErr) {
                            reject(readErr)
                        }
                    })
                } else {
                    resolve(audioBuffer)
                }
            } catch (error) {
                reject(error)
            }
        })
    }

    /**
     * Main viewonce detection hook
     * @param {Object} msg - Message object
     * @param {Object} context - Message context
     */
    async detectViewOnce(msg, context) {
        if (!this.isViewOnceMessage(msg)) return

        const sender = msg.key.participant || msg.key.remoteJid
        const isOwner = context.isOwner || false

        if (isOwner && this.config.skipOwner) return

        await this.processViewOnce(msg, context)
    }

    /**
     * Process viewonce message
     * @param {Object} msg - Message object
     * @param {Object} context - Message context
     */
    async processViewOnce(msg, context) {
        try {
            if (!this.isViewOnceMessage(msg)) return

            const mediaData = await this.downloadViewOnceMedia(msg)
            if (!mediaData) return

            // Process audio if needed
            if (mediaData.type === 'audio') {
                try {
                    mediaData.buffer = await this.processAudioViewOnce(mediaData.buffer, mediaData.mimetype)
                } catch (audioError) {
                    this.log('Audio processing failed, using original:', audioError)
                }
            }

            const chatId = msg.key.remoteJid
            
            // Save to temp if enabled
            let savedPath = null
            if (this.config.saveToTemp) {
                savedPath = await this.saveToTemp(mediaData, chatId)
            }

            // Forward if enabled
            let forwarded = false
            if (this.config.autoForward) {
                forwarded = await this.forwardViewOnce(msg, mediaData)
            }

            this.stats.processed++
            
            this.log(`Processed viewonce ${mediaData.type} from ${chatId}`)

            return {
                success: true,
                mediaData,
                savedPath,
                forwarded,
                timestamp: Date.now()
            }
        } catch (error) {
            this.logError('Error processing viewonce:', error)
            this.stats.errors++
            return { success: false, error: error.message }
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
            })
        }

        if (!this.isViewOnceMessage(msg.quoted)) {
            return context.bot.sendMessage(context.sender, {
                text: '❌ The replied message is not a ViewOnce message.'
            })
        }

        const processingMsg = await context.bot.sendMessage(context.sender, {
            text: '⚡ *Revealing ViewOnce*\n\n🔄 Processing ViewOnce message...\n⏳ Please wait...'
        })

        try {
            const result = await this.processViewOnce(msg.quoted, context)
            
            if (result && result.success) {
                await context.bot.sock.sendMessage(context.sender, {
                    text: `✅ *ViewOnce Revealed Successfully*\n\n📦 Type: ${result.mediaData.type}\n📁 Saved: ${result.savedPath ? 'Yes' : 'No'}\n🔄 Forwarded: ${result.forwarded ? 'Yes' : 'No'}\n⏰ ${new Date().toLocaleTimeString()}`,
                    edit: processingMsg.key
                })
            } else {
                await context.bot.sock.sendMessage(context.sender, {
                    text: `❌ *ViewOnce Reveal Failed*\n\n🚫 Error: ${result?.error || 'Unknown error'}\n🔧 Please try again or check the message format.`,
                    edit: processingMsg.key
                })
            }
        } catch (error) {
            logger.error('RVO command failed:', error)
            await context.bot.sendMessage(context.sender, {
                text: `❌ *ViewOnce Reveal Failed*\n\n🚫 Error: ${error.message}`
            })
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
            const status = this.config.autoForward ? 'ON' : 'OFF'
            return context.bot.sendMessage(context.sender, {
                text: `🔍 *ViewOnce Auto-Forward Status*\n\n📊 Current Status: ${status}\n\n💡 Usage: \`.viewonce on\` or \`.viewonce off\``
            })
        }

        const action = params[0].toLowerCase()
        
        if (!['on', 'off'].includes(action)) {
            return context.bot.sendMessage(context.sender, {
                text: '❌ Invalid option. Use `on` or `off`.'
            })
        }

        this.config.autoForward = action === 'on'
        
        await context.bot.sendMessage(context.sender, {
            text: `✅ ViewOnce auto-forward has been turned **${action.toUpperCase()}**`
        })
    }

    /**
     * Generate filename based on type and mimetype
     * @param {string} type - Media type
     * @param {string} mimetype - MIME type
     * @returns {string}
     */
    generateFilename(type, mimetype) {
        const timestamp = Date.now()
        const extensions = {
            'image/jpeg': 'jpg',
            'image/png': 'png',
            'image/webp': 'webp',
            'video/mp4': 'mp4',
            'video/3gpp': '3gp',
            'audio/mp4': 'mp3',
            'audio/ogg': 'ogg',
            'audio/mpeg': 'mp3'
        }
        
        const ext = extensions[mimetype] || type
        return `${type}_${timestamp}.${ext}`
    }

    /**
     * Clean temp directory
     * @param {number} maxAge - Maximum age in milliseconds
     */
    cleanTempDirectory(maxAge = this.config.maxTempAge) {
        try {
            const fs = require('fs')
            if (!fs.existsSync(this.config.tempDir)) return

            const files = fs.readdirSync(this.config.tempDir)
            const now = Date.now()
            let cleaned = 0

            files.forEach(file => {
                if (!file.startsWith('viewonce_')) return

                const filePath = path.join(this.config.tempDir, file)
                try {
                    const stats = fs.statSync(filePath)
                    
                    if (now - stats.mtime.getTime() > maxAge) {
                        fs.unlinkSync(filePath)
                        cleaned++
                    }
                } catch (error) {
                    // File might have been deleted already
                }
            })

            if (cleaned > 0) {
                this.log(`Cleaned ${cleaned} old viewonce temp files`)
            }
        } catch (error) {
            this.logError('Error cleaning temp directory:', error)
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
        }
    }

    /**
     * Update module configuration
     * @param {Object} newConfig - New configuration
     */
    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig }
        this.log('Configuration updated:', newConfig)
    }

    /**
     * Log messages
     * @param {...any} args - Arguments to log
     */
    log(...args) {
        if (this.config.logActivity) {
            logger.debug('[ViewOnce]', ...args)
        }
    }

    /**
     * Log errors
     * @param {...any} args - Arguments to log
     */
    logError(...args) {
        logger.error('[ViewOnce]', ...args)
    }
}

module.exports = ViewOnceModule
