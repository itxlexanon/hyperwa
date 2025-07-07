const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs-extra');
const path = require('path');

const config = require('../config');
const logger = require('./logger');
const MessageHandler = require('./message-handler');
const TelegramBridge = require('../watg-bridge/bridge');
const { connectDb } = require('../utils/db');
const ModuleLoader = require('./module-loader');
const { useMongoAuthState } = require('../utils/mongoAuthState'); 
class HyperWaBot {
    constructor() {
        this.sock = null;
        this.authPath = './auth_info';
        this.messageHandler = new MessageHandler(this);
        this.telegramBridge = null;
        this.isShuttingDown = false;
        this.db = null;
        this.moduleLoader = new ModuleLoader(this);
        this.qrCodeSent = false;
        this.useMongoAuth = config.get('auth.useMongoAuth', false); // Add config option for MongoDB auth
    }

    async initialize() {
        logger.info('🔧 Initializing HyperWa Userbot...');
        
        // Connect to the database
        try {
            this.db = await connectDb();
            logger.info('✅ Database connected successfully!');
        } catch (error) {
            logger.error('❌ Failed to connect to database:', error);
            logger.info('🔄 Retrying database connection in 10 seconds...');
            setTimeout(() => this.initialize(), 10000);
            return;
        }

        // Initialize Telegram bridge first (for QR code sending)
        if (config.get('telegram.enabled')) {
            try {
                this.telegramBridge = new TelegramBridge(this);
                await this.telegramBridge.initialize();
                logger.info('✅ Telegram bridge initialized');
            } catch (error) {
                logger.error('❌ Failed to initialize Telegram bridge:', error);
                // Don't exit, continue without Telegram bridge
            }
        }

        // Load modules using the ModuleLoader
        try {
            await this.moduleLoader.loadModules();
        } catch (error) {
            logger.error('❌ Failed to load modules:', error);
            // Don't exit, continue without modules
        }
        
        // Start WhatsApp connection
        await this.startWhatsApp();
        
        logger.info('✅ HyperWa Userbot initialized successfully!');
    }

    async startWhatsApp() {
        let state, saveCreds;
        
        // Choose auth method based on configuration
        if (this.useMongoAuth) {
            logger.info('🔧 Using MongoDB auth state...');
            try {
                ({ state, saveCreds } = await useMongoAuthState());
            } catch (error) {
                logger.error('❌ Failed to initialize MongoDB auth state:', error);
                logger.info('🔄 Falling back to file-based auth...');
                ({ state, saveCreds } = await useMultiFileAuthState(this.authPath));
            }
        } else {
            logger.info('🔧 Using file-based auth state...');
            ({ state, saveCreds } = await useMultiFileAuthState(this.authPath));
        }

        const { version } = await fetchLatestBaileysVersion();

        try {
            this.sock = makeWASocket({
                auth: state,
                version,
                printQRInTerminal: false, // Handle QR manually
                logger: logger.child({ module: 'baileys' }),
                getMessage: async (key) => ({ conversation: 'Message not found' }),
                browser: ['HyperWa', 'Chrome', '3.0'],
            });

            // Timeout for QR code scanning
            const connectionTimeout = setTimeout(() => {
                if (!this.sock.user) {
                    logger.warn('❌ QR code scan timed out after 30 seconds');
                    logger.info('🔄 Retrying with new QR code...');
                    this.sock.end(); // Close current socket
                    setTimeout(() => this.startWhatsApp(), 5000); // Restart connection
                }
            }, 30000);

            this.setupEventHandlers(saveCreds);
            await new Promise(resolve => this.sock.ev.on('connection.update', update => {
                if (update.connection === 'open') {
                    clearTimeout(connectionTimeout); // Clear timeout on successful connection
                    resolve();
                }
            }));
        } catch (error) {
            logger.error('❌ Failed to initialize WhatsApp socket:', error);
            logger.info('🔄 Retrying with new QR code...');
            setTimeout(() => this.startWhatsApp(), 5000); // Retry on error
        }
    }

    setupEventHandlers(saveCreds) {
        this.sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                logger.info('📱 Scan QR code with WhatsApp:');
                qrcode.generate(qr, { small: true });

                // Send QR code to Telegram if bridge is enabled
                if (this.telegramBridge && config.get('telegram.enabled') && config.get('telegram.botToken')) {
                    try {
                        await this.telegramBridge.sendQRCode(qr);
                        logger.info('✅ QR code sent to Telegram');
                    } catch (error) {
                        logger.error('❌ Failed to send QR code to Telegram:', error);
                    }
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode || 0;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                if (shouldReconnect && !this.isShuttingDown) {
                    logger.warn('🔄 Connection closed, reconnecting...');
                    setTimeout(() => this.startWhatsApp(), 5000);
                } else {
                    logger.error('❌ Connection closed permanently. Clearing session and retrying...');
                    // If using MongoDB auth, clear the session
                    if (this.useMongoAuth) {
                        try {
                            const db = await connectDb();
                            const coll = db.collection("auth");
                            await coll.deleteOne({ _id: "session" });
                            logger.info('🗑️ MongoDB auth session cleared');
                        } catch (error) {
                            logger.error('❌ Failed to clear MongoDB auth session:', error);
                        }
                    } else {
                        // Clear local auth files
                        try {
                            await fs.remove(this.authPath);
                            logger.info('🗑️ Local auth files cleared');
                        } catch (error) {
                            logger.error('❌ Failed to clear local auth files:', error);
                        }
                    }
                    // Retry connection instead of exiting
                    logger.info('🔄 Retrying connection in 10 seconds...');
                    setTimeout(() => this.startWhatsApp(), 10000);
                }
            } else if (connection === 'open') {
                await this.onConnectionOpen();
            }
        });

        this.sock.ev.on('creds.update', saveCreds);
        this.sock.ev.on('messages.upsert', (update) => {
            try {
                this.messageHandler.handleMessages(update);
            } catch (error) {
                logger.error('❌ Error handling message:', error);
                // Don't crash, just log the error and continue
            }
        });
    }

    async onConnectionOpen() {
        logger.info(`✅ Connected to WhatsApp! User: ${this.sock.user?.id || 'Unknown'}`);
        
        // Set owner if not set
        if (!config.get('bot.owner') && this.sock.user) {
            config.set('bot.owner', this.sock.user.id);
            logger.info(`👑 Owner set to: ${this.sock.user.id}`);
        }

        // Setup WhatsApp handlers for Telegram bridge
        if (this.telegramBridge) {
            await this.telegramBridge.setupWhatsAppHandlers();
        }

        // Send startup message to owner and Telegram
        await this.sendStartupMessage();
        
        // Notify Telegram bridge of connection
        if (this.telegramBridge) {
            await this.telegramBridge.syncWhatsAppConnection();
        }
    }

    async sendStartupMessage() {
        const owner = config.get('bot.owner');
        if (!owner) return;

        const authMethod = this.useMongoAuth ? 'MongoDB' : 'File-based';
        const startupMessage = `🚀 *${config.get('bot.name')} v${config.get('bot.version')}* is now online!\n\n` +
                              `🔥 *HyperWa Features Active:*\n` +
                              `• 📱 Modular Architecture\n` +
                              `• 🔐 Auth Method: ${authMethod}\n` +
                              `• 🤖 Telegram Bridge: ${config.get('telegram.enabled') ? '✅' : '❌'}\n` +
                              `• 🔧 Custom Modules: ${config.get('features.customModules') ? '✅' : '❌'}\n` +
                              `Type *${config.get('bot.prefix')}help* for available commands!`;

        try {
            await this.sock.sendMessage(owner, { text: startupMessage });
            
            if (this.telegramBridge) {
                await this.telegramBridge.logToTelegram('🚀 HyperWa Bot Started', startupMessage);
            }
        } catch (error) {
            logger.error('Failed to send startup message:', error);
            // Don't crash, just log the error
        }
    }

    async connect() {
        if (!this.sock) {
            await this.startWhatsApp();
        }
        return this.sock;
    }

    async sendMessage(jid, content) {
        if (!this.sock) {
            throw new Error('WhatsApp socket not initialized');
        }
        return await this.sock.sendMessage(jid, content);
    }

    async shutdown() {
        logger.info('🛑 Shutting down HyperWa Userbot...');
        this.isShuttingDown = true;
        
        if (this.telegramBridge) {
            await this.telegramBridge.shutdown();
        }
        
        if (this.sock) {
            await this.sock.end();
        }
        
        logger.info('✅ HyperWa Userbot shutdown complete');
    }
}

// Global error handlers to prevent crashes
process.on('uncaughtException', (error) => {
    logger.error('🚨 Uncaught Exception:', error);
    logger.info('🔄 Bot will continue running...');
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('🚨 Unhandled Rejection at:', promise, 'reason:', reason);
    logger.info('🔄 Bot will continue running...');
});

// Graceful shutdown handlers
process.on('SIGINT', async () => {
    logger.info('🛑 Received SIGINT, shutting down gracefully...');
    // Add your cleanup code here if needed
    process.exit(0);
});

process.on('SIGTERM', async () => {
    logger.info('🛑 Received SIGTERM, shutting down gracefully...');
    // Add your cleanup code here if needed
    process.exit(0);
});

module.exports = { HyperWaBot };
