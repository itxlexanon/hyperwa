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
const { useMongoAuthState } = require('./mongoAuthState');
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
    }

    async initialize() {
        logger.info('🔧 Initializing HyperWa Userbot...');
        
        // Connect to the database
        try {
            this.db = await connectDb();
            logger.info('✅ Database connected successfully!');
        } catch (error) {
            logger.error('❌ Failed to connect to database:', error);
            // Do not exit; continue with limited functionality
            logger.warn('⚠️ Continuing without database connection...');
        }

        // Initialize Telegram bridge
        if (config.get('telegram.enabled')) {
            try {
                this.telegramBridge = new TelegramBridge(this);
                await this.telegramBridge.initialize();
                logger.info('✅ Telegram bridge initialized');
            } catch (error) {
                logger.error('❌ Failed to initialize Telegram bridge:', error);
                // Do not exit; continue without Telegram bridge
                logger.warn('⚠️ Continuing without Telegram bridge...');
            }
        }

        // Load modules
        try {
            await this.moduleLoader.loadModules();
            logger.info('✅ Modules loaded successfully');
        } catch (error) {
            logger.error('❌ Failed to load modules:', error);
            logger.warn('⚠️ Continuing without custom modules...');
        }
        
        // Start WhatsApp connection
        await this.startWhatsApp();
        
        logger.info('✅ HyperWa Userbot initialized successfully!');
    }

    async startWhatsApp() {
        // Choose auth method based on config
        const useMongo = config.get('auth.useMongo') === true;
        const authMethod = useMongo ? useMongoAuthState : useMultiFileAuthState;
        let state, saveCreds;

        try {
            ({ state, saveCreds } = await authMethod(this.authPath));
            const { version } = await fetchLatestBaileysVersion();

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
            logger.info('🔄 Retrying in 5 seconds...');
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

                if (statusCode === DisconnectReason.loggedOut) {
                    logger.warn('❌ Session logged out. Clearing session and generating new QR code...');
                    // Clear session from MongoDB if using MongoDB auth
                    if (config.get('auth.useMongo') && this.db) {
                        try {
                            await this.db.collection('auth').deleteOne({ _id: 'session' });
                            logger.info('✅ Cleared invalid session from MongoDB');
                        } catch (error) {
                            logger.error('❌ Failed to clear session from MongoDB:', error);
                        }
                    }
                    // Clear local auth_info directory
                    try {
                        await fs.remove(this.authPath);
                        logger.info('✅ Cleared local auth_info directory');
                    } catch (error) {
                        logger.error('❌ Failed to clear auth_info directory:', error);
                    }
                    // Restart WhatsApp connection to generate new QR code
                    logger.info('🔄 Restarting WhatsApp connection...');
                    setTimeout(() => this.startWhatsApp(), 1000);
                } else if (shouldReconnect && !this.isShuttingDown) {
                    logger.warn('🔄 Connection closed, reconnecting...');
                    setTimeout(() => this.startWhatsApp(), 5000);
                } else {
                    logger.error('❌ Connection closed with unexpected error. Retrying...');
                    setTimeout(() => this.startWhatsApp(), 5000);
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
            try {
                config.set('bot.owner', this.sock.user.id);
                logger.info(`👑 Owner set to: ${this.sock.user.id}`);
            } catch (error) {
                logger.error('❌ Failed to set owner:', error);
            }
        }

        // Setup WhatsApp handlers for Telegram bridge
        if (this.telegramBridge) {
            try {
                await this.telegramBridge.setupWhatsAppHandlers();
            } catch (error) {
                logger.error('❌ Failed to setup Telegram bridge handlers:', error);
            }
        }

        // Send startup message
        await this.sendStartupMessage();
        
        // Notify Telegram bridge of connection
        if (this.telegramBridge) {
            try {
                await this.telegramBridge.syncWhatsAppConnection();
            } catch (error) {
                logger.error('❌ Failed to sync Telegram bridge connection:', error);
            }
        }
    }

    async sendStartupMessage() {
        const owner = config.get('bot.owner');
        if (!owner) {
            logger.warn('⚠️ No owner set. Skipping startup message.');
            return;
        }

        const startupMessage = `🚀 *${config.get('bot.name')} v${config.get('bot.version')}* is now online!\n\n` +
                              `🔥 *HyperWa Features Active:*\n` +
                              `• 📱 Modular Architecture\n` +
                              `• 🤖 Telegram Bridge: ${config.get('telegram.enabled') ? '✅' : '❌'}\n` +
                              `• 🔧 Custom Modules: ${config.get('features.customModules') ? '✅' : '❌'}\n` +
                              `• 💾 MongoDB Auth: ${config.get('auth.useMongo') ? '✅' : '❌'}\n` +
                              `Type *${config.get('bot.prefix')}help* for available commands!`;

        try {
            await this.sock.sendMessage(owner, { text: startupMessage });
            logger.info('✅ Startup message sent to owner');
            
            if (this.telegramBridge) {
                await this.telegramBridge.logToTelegram('🚀 HyperWa Bot Started', startupMessage);
                logger.info('✅ Startup message sent to Telegram');
            }
        } catch (error) {
            logger.error('❌ Failed to send startup message:', error);
        }
    }

    async connect() {
        if (!this.sock) {
            await this.startWhatsApp();
        }
        return this.sock;
    }

    async shutdown() {
        logger.info('🛑 Shutting down HyperWa Userbot...');
        this.isShuttingDown = true;
        
        if (this.telegramBridge) {
            try {
                await this.telegramBridge.shutdown();
                logger.info('✅ Telegram bridge shutdown');
            } catch (error) {
                logger.error('❌ Failed to shutdown Telegram bridge:', error);
            }
        }
        
        if (this.sock) {
            try {
                await this.sock.end();
                logger.info('✅ WhatsApp socket closed');
            } catch (error) {
                logger.error('❌ Failed to close WhatsApp socket:', error);
            }
        }
        
        logger.info('✅ HyperWa Userbot shutdown complete');
    }
}

module.exports = { HyperWaBot };
