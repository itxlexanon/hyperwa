const { readFileSync: read, unlinkSync: remove, writeFileSync: create } = require('fs')
const path = require('path')
const { exec } = require('child_process')
const { tmpdir } = require('os')
const { downloadMediaMessage } = require('@whiskeysockets/baileys');


class ViewOnceHandler {
    constructor(client, config = {}) {
        this.client = client
        this.config = {
            autoForward: config.autoForward || true,
            saveToTemp: config.saveToTemp || true,
            tempDir: config.tempDir || './temp',
            enableInGroups: config.enableInGroups || true,
            enableInPrivate: config.enableInPrivate || true,
            logActivity: config.logActivity || true,
            ...config
        }
        
        // Ensure temp directory exists
        this.ensureTempDir()
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
            // Handle different viewonce message structures
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

            // Determine media type and extract content
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
            this.log('Error extracting viewonce content:', error)
            return null
        }
    }

    /**
     * Download viewonce media
     * @param {Object} msg - Message object
     * @returns {Promise<Buffer|null>}
     */
    async downloadViewOnceMedia(msg) {
        try {
            const viewOnceContent = this.extractViewOnceContent(msg)
            if (!viewOnceContent) return null

            // Download the media
            const buffer = await downloadMediaMessage({
    key: msg.key,
    message: { [`${viewOnceContent.type}Message`]: viewOnceContent.content }
}, 'buffer', {});

            
            if (this.config.logActivity) {
                this.log(`Downloaded viewonce ${viewOnceContent.type} from ${msg.key.remoteJid}`)
            }

            return {
                buffer,
                type: viewOnceContent.type,
                mimetype: viewOnceContent.mimetype,
                caption: viewOnceContent.caption,
                filename: this.generateFilename(viewOnceContent.type, viewOnceContent.mimetype)
            }
        } catch (error) {
            this.log('Error downloading viewonce media:', error)
            return null
        }
    }

    /**
     * Save viewonce media to temp directory
     * @param {Object} mediaData - Media data from downloadViewOnceMedia
     * @param {string} chatId - Chat ID for organization
     * @returns {Promise<string|null>} - File path if saved successfully
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
            return filePath
        } catch (error) {
            this.log('Error saving to temp:', error)
            return null
        }
    }

    /**
     * Forward viewonce media to same chat
     * @param {Object} msg - Original message object
     * @param {Object} mediaData - Media data from downloadViewOnceMedia
     * @returns {Promise<boolean>}
     */
    async forwardViewOnce(msg, mediaData) {
        if (!this.config.autoForward || !mediaData) return false

        try {
            const chatId = msg.key.remoteJid
            const isGroup = chatId.endsWith('@g.us')
            
            // Check if forwarding is enabled for this chat type
            if (isGroup && !this.config.enableInGroups) return false
            if (!isGroup && !this.config.enableInPrivate) return false

            // Prepare message based on media type
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

            // Send the forwarded message
            await this.client.sendMessage(chatId, messageContent)
            
            this.log(`Forwarded viewonce ${mediaData.type} to ${chatId}`)
            return true
        } catch (error) {
            this.log('Error forwarding viewonce:', error)
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
                    // Convert OGG to MP3
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
     * Handle viewonce message completely
     * @param {Object} msg - Message object
     * @returns {Promise<Object|null>}
     */
    async handleViewOnceMessage(msg) {
        try {
            if (!this.isViewOnceMessage(msg)) return null

            const sender = msg.key.participant || msg.key.remoteJid
            const chatId = msg.key.remoteJid
            const isOwner = this.isOwner ? this.isOwner(sender) : false

            // Skip if it's from owner (configurable)
            if (isOwner && this.config.skipOwner) return null

            // Download the media
            const mediaData = await this.downloadViewOnceMedia(msg)
            if (!mediaData) return null

            // Process audio if needed
            if (mediaData.type === 'audio') {
                try {
                    mediaData.buffer = await this.processAudioViewOnce(mediaData.buffer, mediaData.mimetype)
                } catch (audioError) {
                    this.log('Audio processing failed, using original:', audioError)
                }
            }

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

            return {
                success: true,
                mediaData,
                savedPath,
                forwarded,
                sender,
                chatId,
                timestamp: Date.now()
            }
        } catch (error) {
            this.log('Error handling viewonce message:', error)
            return {
                success: false,
                error: error.message
            }
        }
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
     * Set owner checker function
     * @param {Function} ownerChecker - Function to check if user is owner
     */
    setOwnerChecker(ownerChecker) {
        this.isOwner = ownerChecker
    }

    /**
     * Update configuration
     * @param {Object} newConfig - New configuration options
     */
    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig }
    }

    /**
     * Get current configuration
     * @returns {Object}
     */
    getConfig() {
        return { ...this.config }
    }

    /**
     * Clean temp directory
     * @param {number} maxAge - Maximum age in milliseconds (default: 1 hour)
     */
    cleanTempDirectory(maxAge = 3600000) {
        try {
            const fs = require('fs')
            const files = fs.readdirSync(this.config.tempDir)
            const now = Date.now()

            files.forEach(file => {
                const filePath = path.join(this.config.tempDir, file)
                const stats = fs.statSync(filePath)
                
                if (now - stats.mtime.getTime() > maxAge) {
                    fs.unlinkSync(filePath)
                    this.log(`Cleaned old temp file: ${file}`)
                }
            })
        } catch (error) {
            this.log('Error cleaning temp directory:', error)
        }
    }

    /**
     * Log messages (can be overridden)
     * @param {...any} args - Arguments to log
     */
    log(...args) {
        if (this.config.logActivity) {
            console.log('[ViewOnce]', ...args)
        }
    }

    /**
     * Get statistics
     * @returns {Object}
     */
    getStats() {
        // This would need to be implemented with persistent storage
        // For now, return basic info
        return {
            tempDir: this.config.tempDir,
            tempDirExists: require('fs').existsSync(this.config.tempDir),
            config: this.getConfig()
        }
    }
}

// Export the class and a helper function
module.exports = {
    ViewOnceHandler,
    
    /**
     * Create and configure a ViewOnce handler
     * @param {Object} client - WhatsApp client instance
     * @param {Object} config - Configuration options
     * @returns {ViewOnceHandler}
     */
    createViewOnceHandler: (client, config = {}) => {
        return new ViewOnceHandler(client, config)
    },

    /**
     * Quick setup for basic viewonce handling
     * @param {Object} client - WhatsApp client instance
     * @param {Object} options - Basic options
     * @returns {Function} - Message handler function
     */
    setupViewOnceHandler: (client, options = {}) => {
        const handler = new ViewOnceHandler(client, options)
        
        return async (msg) => {
            if (handler.isViewOnceMessage(msg)) {
                return await handler.handleViewOnceMessage(msg)
            }
            return null
        }
    }
}
