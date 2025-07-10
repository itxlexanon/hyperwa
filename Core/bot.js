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
        process.exit(1);
    }

    // Initialize Telegram bridge first (for QR code sending)
    if (config.get('telegram.enabled')) {
        try {
            this.telegramBridge = new TelegramBridge(this);
            await this.telegramBridge.initialize();
            logger.info('✅ Telegram bridge initialized');
            // Add this line:
            await this.telegramBridge.sendStartMessage();
        } catch (error) {
            logger.error('❌ Failed to initialize Telegram bridge:', error);
        }
    }
        // Load modules using the ModuleLoader
        await this.moduleLoader.loadModules();
        
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

// In the connection.update handler:
if (qr) {
    logger.info('📱 WhatsApp QR code generated');
    
    // Always show in terminal as fallback
    qrcode.generate(qr, { small: true });
    
    // Enhanced Telegram QR sending with retries
    if (this.telegramBridge) {
        let attempts = 0;
        const maxAttempts = 3;
        const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
        
        while (attempts < maxAttempts) {
            attempts++;
            try {
                await delay(500 * attempts); // Progressive delay
                
                logger.debug(`Attempt ${attempts} to send QR via Telegram...`);
                const success = await this.telegramBridge.sendQRCode(qr);
                
                if (success) {
                    logger.info('✅ QR code successfully sent to Telegram');
                    break;
                }
            } catch (error) {
                logger.error(`Attempt ${attempts} failed:`, error.message);
                if (attempts === maxAttempts) {
                    logger.error('❌ All attempts to send QR via Telegram failed');
                }
            }
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
                    logger.error('❌ Connection closed permanently. Please delete auth_info and restart.');
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
                    }
                    process.exit(1); // Exit only for permanent closure (e.g., logged out)
                }
            } else if (connection === 'open') {
                await this.onConnectionOpen();
            }
        });

        this.sock.ev.on('creds.update', saveCreds);
        this.sock.ev.on('messages.upsert', this.messageHandler.handleMessages.bind(this.messageHandler));
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

module.exports = { HyperWaBot };
