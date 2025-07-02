class Config {
    constructor() {
        this.defaultConfig = {
            // Bot core settings
            bot: {
                // Bot identification and core configuration
                name: 'NexusWA', // Bot display name
                company: 'Dawium Technologies', // Company/organization name
                prefix: '.', // Command prefix
                version: '2.0.0', // Bot version
                owner: '923298784489@s.whatsapp.net', // Owner's WhatsApp JID
                clearAuthOnStart: false // Clear auth on startup (debug only)
            },

            // Feature toggles and configurations
            features: {
                mode: 'public', // Bot mode: 'public' or 'private'
                autoViewStatus: true, // Automatically view WhatsApp status updates
                customModules: true, // Enable loading of custom modules
                rateLimiting: true, // Enable command rate limiting
                telegramBridge: true, // Enable Telegram bridge integration
                smartProcessing: true, // Enable smart message processing
                editMessages: true, // Allow editing of sent messages
                autoReact: true // Auto react to commands
            },

            // Database configuration
database: {
  mongodb: {
    uri: 'mongodb+srv://itxelijah07:ivp8FYGsbVfjQOkj@cluster0.wh25x.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0',
    dbName: 'advancedwa'
  }
}


            // External API configurations
            apis: {
                ninjas: '', // API key for Ninjas API
                weather: '', // API key for weather service
                translate: '' // API key for translation service
            },

            // Security configurations
            security: {
                maxCommandsPerMinute: 10, // Maximum commands allowed per minute per user
                maxDownloadsPerHour: 20, // Maximum downloads allowed per hour
                allowedDomains: ['youtube.com', 'instagram.com', 'tiktok.com'], // Allowed domains for media downloads
                blockedUsers: [], // List of blocked user IDs
                maxMessageLength: 4096 // Maximum message length in characters
            },

            // Telegram integration settings
            telegram: {
                enabled: true, // Enable Telegram integration
                botToken: '7580382614:AAH30PW6TFmgRzbC7HUXIHQ35GpndbJOIEI', // Telegram bot token
                chatId: '-1002287300661', // Telegram chat ID for messages
                logChannel: '', // Telegram channel for logging
                ownerId: '', // Telegram owner ID
                adminIds: ['7580382614'], // List of Telegram admin IDs
                sudoUsers: ['7580382614'], // List of Telegram sudo users
                features: {
                    topics: true, // Enable Telegram topics
                    mediaSync: true, // Sync media between platforms
                    profilePicSync: true, // Sync profile pictures
                    callLogs: true, // Log WhatsApp calls
                    statusSync: true, // Sync WhatsApp status updates
                    biDirectional: true, // Enable bidirectional messaging
                    readReceipts: true, // Send read receipts
                    presenceUpdates: true, // Send presence updates
                    animatedStickers: true // Enable animated sticker support
                }
            },

            // Logging configuration
            logging: {
                level: 'info', // Log level: 'debug', 'info', 'warn', 'error'
                saveToFile: true, // Save logs to file
                maxFileSize: '10MB', // Maximum log file size
                maxFiles: 5, // Maximum number of log files to keep
                logDir: './logs' // Directory for log files
            },

            // Temporary file storage
            storage: {
                tempDir: './temp', // Directory for temporary files
                maxTempFileAge: 3600 // Maximum age of temp files in seconds
            }
        };

        this.load();
        this.validate();
    }

    /**
     * Load configuration into memory
     */
    load() {
        this.config = { ...this.defaultConfig };
        console.log('✅ Configuration loaded successfully');
    }

    /**
     * Validate critical configuration settings
     * @throws Error if critical settings are missing or invalid
     */
    validate() {
        const errors = [];

        // Validate bot owner
        if (!this.config.bot.owner.includes('@s.whatsapp.net')) {
            errors.push('Invalid bot.owner format. Must include @s.whatsapp.net');
        }

        // Validate Telegram settings if enabled
        if (this.config.telegram.enabled) {
            if (!this.config.telegram.botToken || this.config.telegram.botToken.includes('YOUR_BOT_TOKEN')) {
                errors.push('Invalid or missing telegram.botToken');
            }
            if (!this.config.telegram.chatId || this.config.telegram.chatId.includes('YOUR_CHAT_ID')) {
                errors.push('Invalid or missing telegram.chatId');
            }
        }

        // Validate database settings
        if (!this.config.database.mongodb.uri || this.config.database.mongodb.uri.includes('YOUR_MONGO_URI')) {
            errors.push('Invalid or missing mongodb.uri');
        }

        if (errors.length > 0) {
            console.error('❌ Configuration validation failed:', errors.join('\n'));
            throw new Error('Configuration validation failed');
        }
    }

    /**
     * Get configuration value by dot-notation key
     * @param {string} key - Configuration key (e.g., 'bot.name', 'telegram.features.topics')
     * @returns {*} Configuration value
     */
    get(key) {
        const value = key.split('.').reduce((o, k) => o && o[k], this.config);
        if (value === undefined) {
            console.warn(`⚠️ Configuration key '${key}' not found`);
        }
        return value;
    }

    /**
     * Set configuration value by dot-notation key
     * @param {string} key - Configuration key
     * @param {*} value - Value to set
     */
    set(key, value) {
        const keys = key.split('.');
        const lastKey = keys.pop();
        const target = keys.reduce((o, k) => {
            if (typeof o[k] === 'undefined') o[k] = {};
            return o[k];
        }, this.config);
        target[lastKey] = value;
        console.warn(`⚠️ Config key '${key}' was set to '${value}' (in-memory only). Consider updating config.js for persistence.`);
    }

    /**
     * Update multiple configuration settings
     * @param {Object} updates - Object containing key-value pairs to update
     */
    update(updates) {
        this.config = { ...this.config, ...updates };
        console.warn('⚠️ Config was updated in memory. Consider updating config.js for persistence.');
        this.validate();
    }

    /**
     * Get all configuration settings
     * @returns {Object} Complete configuration object
     */
    getAll() {
        return { ...this.config };
    }
}

module.exports = new Config();
