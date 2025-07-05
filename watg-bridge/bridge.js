const TelegramBot = require('node-telegram-bot-api');
const TelegramCommands = require('./commands');
const config = require('../config');
const logger = require('../Core/logger');
const { connectDb } = require('../utils/db');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');
const mime = require('mime-types');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const ffmpeg = require('fluent-ffmpeg');
const { Sticker, StickerTypes } = require('wa-sticker-formatter');
const { exec } = require('child_process');


class TelegramBridge {
    constructor(whatsappBot) {
        this.whatsappBot = whatsappBot;
        this.telegramBot = null;
        this.commands = null;
        this.chatMappings = new Map();
        this.userMappings = new Map();
        this.contactMappings = new Map();
        this.profilePicCache = new Map(); // Still a Map in memory, but will be backed by DB
        this.messageMappings = new Map(); // New: Map WhatsApp message ID to Telegram message ID
        this.tempDir = path.join(__dirname, '../temp');
        this.isProcessing = false;
        this.activeCallNotifications = new Map();
        this.statusMessageMapping = new Map(); // Map Telegram message ID to WhatsApp status key
        this.presenceTimeout = null;
        this.botChatId = null;
        this.db = null;
        this.collection = null;
        this.messageQueue = new Map();
        this.lastPresenceUpdate = new Map();
        this.topicVerificationCache = new Map();
        this.pollingRetries = 0;
        this.maxPollingRetries = 5;
    }

    async initialize() {
        const token = config.get('telegram.botToken');
        const chatId = config.get('telegram.chatId');
        
        if (!token || token.includes('YOUR_BOT_TOKEN') || !chatId || chatId.includes('YOUR_CHAT_ID')) {
            logger.warn('⚠️ Telegram bot token or chat ID not configured');
            return;
        }

        try {
            await this.initializeDatabase();
            await fs.ensureDir(this.tempDir);
            
            // Enhanced Telegram bot initialization with better error handling
            this.telegramBot = new TelegramBot(token, { 
                polling: {
                    interval: 1000,
                    autoStart: true,
                    params: {
                        timeout: 10,
                        allowed_updates: ['message', 'callback_query']
                    }
                },
                onlyFirstMatch: true,
                request: {
                    agentOptions: {
                        keepAlive: true,
                        family: 4
                    },
                    url: 'https://api.telegram.org'
                }
            });
            
            this.commands = new TelegramCommands(this);
            await this.commands.registerBotCommands();
            await this.setupTelegramHandlers();
            await this.loadMappingsFromDb();
            await this.loadProfilePicCacheFromDb(); // Load profile pic cache
            await this.loadMessageMappingsFromDb(); // Load message mappings
            
            if (this.whatsappBot?.sock?.user) {
                await this.syncContacts();
                await this.updateTopicNames();
            }
            
            logger.info('✅ Telegram bridge initialized');
        } catch (error) {
            logger.error('❌ Failed to initialize Telegram bridge:', error);
        }
    }

    async initializeDatabase() {
        try {
            this.db = await connectDb();
            await this.db.command({ ping: 1 });
            logger.info('✅ MongoDB connection successful');
            this.collection = this.db.collection('bridge');
            await this.collection.createIndex({ type: 1, 'data.whatsappJid': 1 }, { unique: true, partialFilterExpression: { type: 'chat' } });
            await this.collection.createIndex({ type: 1, 'data.whatsappId': 1 }, { unique: true, partialFilterExpression: { type: 'user' } });
            await this.collection.createIndex({ type: 1, 'data.phone': 1 }, { unique: true, partialFilterExpression: { type: 'contact' } });
            await this.collection.createIndex({ type: 1, 'data.jid': 1 }, { unique: true, partialFilterExpression: { type: 'profilePic' } }); // New index for profile pics
            await this.collection.createIndex({ type: 1, 'data.whatsappMessageId': 1 }, { unique: true, partialFilterExpression: { type: 'messageMapping' } }); // New index for message mappings
            await this.collection.createIndex({ type: 1, 'data.telegramMessageId': 1 }, { unique: true, partialFilterExpression: { type: 'messageMapping' } }); // New index for message mappings
            logger.info('📊 Database initialized for Telegram bridge (single collection: bridge)');
        } catch (error) {
            logger.error('❌ Failed to initialize database:', error);
        }
    }

    async loadMappingsFromDb() {
        try {
            const mappings = await this.collection.find({
                type: { $in: ['chat', 'user', 'contact'] }
            }).toArray();
            
            for (const mapping of mappings) {
                switch (mapping.type) {
                    case 'chat':
                        this.chatMappings.set(mapping.data.whatsappJid, mapping.data.telegramTopicId);
                        break;
                    case 'user':
                        this.userMappings.set(mapping.data.whatsappId, {
                            name: mapping.data.name,
                            phone: mapping.data.phone,
                            firstSeen: mapping.data.firstSeen,
                            messageCount: mapping.data.messageCount || 0
                        });
                        break;
                    case 'contact':
                        this.contactMappings.set(mapping.data.phone, mapping.data.name);
                        break;
                }
            }
            
            logger.info(`📊 Loaded mappings: ${this.chatMappings.size} chats, ${this.userMappings.size} users, ${this.contactMappings.size} contacts`);
        } catch (error) {
            logger.error('❌ Failed to load mappings:', error);
        }
    }

    async loadProfilePicCacheFromDb() {
        try {
            const profilePics = await this.collection.find({ type: 'profilePic' }).toArray();
            for (const pic of profilePics) {
                this.profilePicCache.set(pic.data.jid, pic.data.url);
            }
            logger.info(`🖼️ Loaded ${this.profilePicCache.size} profile pictures from DB`);
        } catch (error) {
            logger.error('❌ Failed to load profile picture cache:', error);
        }
    }

    async saveProfilePictureCache(jid, url) {
        try {
            await this.collection.updateOne(
                { type: 'profilePic', 'data.jid': jid },
                { $set: { type: 'profilePic', data: { jid, url, updatedAt: new Date() } } },
                { upsert: true }
            );
            this.profilePicCache.set(jid, url);
            logger.debug(`🖼️ Saved profile picture for ${jid} to DB`);
        } catch (error) {
            logger.error('❌ Failed to save profile picture to DB:', error);
        }
    }

    async loadMessageMappingsFromDb() {
        try {
            const mappings = await this.collection.find({ type: 'messageMapping' }).toArray();
            for (const mapping of mappings) {
                this.messageMappings.set(mapping.data.whatsappMessageId, mapping.data.telegramMessageId);
            }
            logger.info(`💬 Loaded ${this.messageMappings.size} message mappings from DB`);
        } catch (error) {
            logger.error('❌ Failed to load message mappings:', error);
        }
    }

    async saveMessageMapping(whatsappMessageId, telegramMessageId) {
        try {
            await this.collection.updateOne(
                { type: 'messageMapping', 'data.whatsappMessageId': whatsappMessageId },
                { $set: { type: 'messageMapping', data: { whatsappMessageId, telegramMessageId, createdAt: new Date() } } },
                { upsert: true }
            );
            this.messageMappings.set(whatsappMessageId, telegramMessageId);
            logger.debug(`🔗 Saved message mapping: WhatsApp ${whatsappMessageId} -> Telegram ${telegramMessageId}`);
        } catch (error) {
            logger.error('❌ Failed to save message mapping:', error);
        }
    }

    async getWhatsappKeyFromTelegramMessageId(telegramMessageId) {
        try {
            const mapping = await this.collection.findOne({ type: 'messageMapping', 'data.telegramMessageId': telegramMessageId });
            if (mapping) {
                return mapping.data.whatsappMessageId;
            }
            return null;
        } catch (error) {
            logger.error('❌ Failed to get WhatsApp key from Telegram message ID:', error);
            return null;
        }
    }

    async getTelegramMessageIdFromWhatsappKey(whatsappMessageId) {
        try {
            const mapping = await this.collection.findOne({ type: 'messageMapping', 'data.whatsappMessageId': whatsappMessageId });
            if (mapping) {
                return mapping.data.telegramMessageId;
            }
            return null;
        } catch (error) {
            logger.error('❌ Failed to get Telegram message ID from WhatsApp key:', error);
            return null;
        }
    }

    async saveChatMapping(whatsappJid, telegramTopicId) {
        try {
            await this.collection.updateOne(
                { type: 'chat', 'data.whatsappJid': whatsappJid },
                { 
                    $set: { 
                        type: 'chat',
                        data: { 
                            whatsappJid, 
                            telegramTopicId, 
                            createdAt: new Date(),
                            lastActivity: new Date()
                        } 
                    } 
                },
                { upsert: true }
            );
            this.chatMappings.set(whatsappJid, telegramTopicId);
            this.topicVerificationCache.delete(whatsappJid);
            logger.debug(`✅ Saved chat mapping: ${whatsappJid} -> ${telegramTopicId}`);
        } catch (error) {
            logger.error('❌ Failed to save chat mapping:', error);
        }
    }

    async saveUserMapping(whatsappId, userData) {
        try {
            await this.collection.updateOne(
                { type: 'user', 'data.whatsappId': whatsappId },
                { 
                    $set: { 
                        type: 'user',
                        data: { 
                            whatsappId,
                            name: userData.name,
                            phone: userData.phone,
                            firstSeen: userData.firstSeen,
                            messageCount: userData.messageCount || 0,
                            lastSeen: new Date()
                        } 
                    } 
                },
                { upsert: true }
            );
            this.userMappings.set(whatsappId, userData);
            logger.debug(`✅ Saved user mapping: ${whatsappId} (${userData.name || userData.phone})`);
        } catch (error) {
            logger.error('❌ Failed to save user mapping:', error);
        }
    }

    async saveContactMapping(phone, name) {
        try {
            await this.collection.updateOne(
                { type: 'contact', 'data.phone': phone },
                { 
                    $set: { 
                        type: 'contact',
                        data: { 
                            phone, 
                            name, 
                            updatedAt: new Date() 
                        } 
                    } 
                },
                { upsert: true }
            );
            this.contactMappings.set(phone, name);
            logger.debug(`✅ Saved contact mapping: ${phone} -> ${name}`);
        } catch (error) {
            logger.error('❌ Failed to save contact mapping:', error);
        }
    }

    async syncContacts() {
        try {
            if (!this.whatsappBot?.sock?.user) {
                logger.warn('⚠️ WhatsApp not connected, skipping contact sync');
                return;
            }
            
            logger.info('📞 Syncing contacts from WhatsApp...');
            
            // Get contacts from WhatsApp store 
            const contacts = this.whatsappBot.sock.store?.contacts || {};
            const contactEntries = Object.entries(contacts);
            
            logger.debug(`🔍 Found ${contactEntries.length} contacts in WhatsApp store`);
            
            let syncedCount = 0;
            
            for (const [jid, contact] of contactEntries) {
                if (!jid || jid === 'status@broadcast' || !contact) continue;
                
                const phone = jid.split('@')[0];
                let contactName = null;
                
                // Extract name from contact 
                if (contact.name && contact.name !== phone && !contact.name.startsWith('+')) {
                    contactName = contact.name;
                } else if (contact.notify && contact.notify !== phone && !contact.notify.startsWith('+')) {
                    contactName = contact.notify;
                } else if (contact.verifiedName && contact.verifiedName !== phone) {
                    contactName = contact.verifiedName;
                }
                
                if (contactName && contactName.length > 2) {
                    const existingName = this.contactMappings.get(phone);
                    if (existingName !== contactName) {
                        await this.saveContactMapping(phone, contactName);
                        syncedCount++;
                        logger.debug(`📞 Synced contact: ${phone} -> ${contactName}`);
                    }
                }
            }
            
            logger.info(`✅ Synced ${syncedCount} new/updated contacts (Total: ${this.contactMappings.size})`);
            
            // Update topic names after contact sync
            if (syncedCount > 0) {
                await this.updateTopicNames();
            }
            
        } catch (error) {
            logger.error('❌ Failed to sync contacts:', error);
        }
    }

    async updateTopicNames() {
        try {
            const chatId = config.get('telegram.chatId');
            if (!chatId || chatId.includes('YOUR_CHAT_ID')) {
                logger.error('❌ Invalid telegram.chatId for updating topic names');
                return;
            }
            
            logger.info('📝 Updating Telegram topic names...');
            let updatedCount = 0;
            
            for (const [jid, topicId] of this.chatMappings.entries()) {
                if (!jid.endsWith('@g.us') && jid !== 'status@broadcast' && jid !== 'call@broadcast') {
                    const phone = jid.split('@')[0];
                    const contactName = this.contactMappings.get(phone) || `+${phone}`;
                    
                    try {
                        await this.telegramBot.editForumTopic(chatId, topicId, {
                            name: contactName
                        });
                        logger.debug(`📝 Updated topic name for ${phone} to ${contactName}`);
                        updatedCount++;
                    } catch (error) {
                        logger.error(`❌ Failed to update topic ${topicId} for ${phone}:`, error);
                    }
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
            }
            
            logger.info(`✅ Updated ${updatedCount} topic names`);
        } catch (error) {
            logger.error('❌ Failed to update topic names:', error);
        }
    }

    async setReaction(chatId, messageId, emoji) {
        try {
            const token = config.get('telegram.botToken');
            await axios.post(`https://api.telegram.org/bot${token}/setMessageReaction`, {
                chat_id: chatId,
                message_id: messageId,
                reaction: [{ type: 'emoji', emoji }]
            });
        } catch (err) {
            logger.debug('❌ Failed to set reaction:', err?.response?.data?.description || err.message);
        }
    }

    async setupTelegramHandlers() {
        // Enhanced error handling for Telegram polling
        this.telegramBot.on('polling_error', (error) => {
            this.pollingRetries++;
            logger.error(`Telegram polling error (attempt ${this.pollingRetries}/${this.maxPollingRetries}):`, error.message);
            
            if (this.pollingRetries >= this.maxPollingRetries) {
                logger.error('❌ Max polling retries reached. Restarting Telegram bot...');
                this.restartTelegramBot();
            }
        });

        this.telegramBot.on('error', (error) => {
            logger.error('Telegram bot error:', error);
        });

        this.telegramBot.on('message', this.wrapHandler(async (msg) => {
            // Reset polling retries on successful message
            this.pollingRetries = 0;
            
            if (msg.chat.type === 'private') {
                this.botChatId = msg.chat.id;
                await this.commands.handleCommand(msg);
            } else if (msg.chat.type === 'supergroup' && msg.is_topic_message) {
                await this.handleTelegramMessage(msg);
            }
        }));

        logger.info('📱 Telegram message handlers set up');
    }

    async restartTelegramBot() {
        try {
            logger.info('🔄 Restarting Telegram bot...');
            
            if (this.telegramBot) {
                await this.telegramBot.stopPolling();
            }
            
            // Wait a bit before restarting
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            const token = config.get('telegram.botToken');
            this.telegramBot = new TelegramBot(token, { 
                polling: {
                    interval: 1000,
                    autoStart: true,
                    params: {
                        timeout: 10,
                        allowed_updates: ['message', 'callback_query']
                    }
                },
                onlyFirstMatch: true,
                request: {
                    agentOptions: {
                        keepAlive: true,
                        family: 4
                    },
                    url: 'https://api.telegram.org'
                }
            });
            
            await this.setupTelegramHandlers();
            this.pollingRetries = 0;
            
            logger.info('✅ Telegram bot restarted successfully');
        } catch (error) {
            logger.error('❌ Failed to restart Telegram bot:', error);
        }
    }

    wrapHandler(handler) {
        return async (...args) => {
            try {
                await handler(...args);
            } catch (error) {
                logger.error('❌ Unhandled error in Telegram handler:', error);
            }
        };
    }

    async logToTelegram(title, message) {
        if (!this.telegramBot) return;

        const logChannel = config.get('telegram.logChannel');
        if (!logChannel || logChannel.includes('YOUR_LOG_CHANNEL')) {
            logger.debug('Telegram log channel not configured');
            return;
        }

        try {
            const logMessage = `🤖 *${title}*\n\n${message}\n\n⏰ ${new Date().toLocaleString()}`;
            
            await this.telegramBot.sendMessage(logChannel, logMessage, {
                parse_mode: 'Markdown'
            });
        } catch (error) {
            logger.debug('Could not send log to Telegram:', error.message);
        }
    }

    async sendQRCode(qrCode) {
        try {
            if (!this.telegramBot) return;

            const qrcode = require('qrcode');
            const qrBuffer = await qrcode.toBuffer(qrCode, { 
                type: 'png', 
                width: 512,
                margin: 2 
            });

            const ownerId = config.get('telegram.ownerId') || config.get('telegram.chatId');
            const logChannel = config.get('telegram.logChannel');

            // Send to owner
            if (ownerId) {
                await this.telegramBot.sendPhoto(ownerId, qrBuffer, {
                    caption: '📱 *Scan QR Code to Login to WhatsApp*\n\nScan this QR code with your WhatsApp mobile app to connect.',
                    parse_mode: 'Markdown'
                });
            }

            // Send to log channel
            if (logChannel && logChannel !== ownerId) {
                await this.telegramBot.sendPhoto(logChannel, qrBuffer, {
                    caption: '📱 *WhatsApp QR Code Generated*\n\nWaiting for scan...',
                    parse_mode: 'Markdown'
                });
            }

            logger.info('📱 QR code sent to Telegram');
            
            // Sync contacts after QR scan (10 seconds delay)
            setTimeout(async () => {
                await this.syncContacts();
            }, 10000);
            
        } catch (error) {
            logger.error('❌ Failed to send QR code to Telegram:', error);
        }
    }

    async sendStartMessage() {
        try {
            if (!this.telegramBot) return;

            const startMessage = `🚀 *HyperWa Bot Started Successfully!*\n\n` +
                               `✅ WhatsApp: Connected\n` +
                               `✅ Telegram Bridge: Active\n` +
                               `📞 Contacts: ${this.contactMappings.size} synced\n` +
                               `💬 Chats: ${this.chatMappings.size} mapped\n` +
                               `🔗 Ready to bridge messages!\n\n` +
                               `⏰ Started at: ${new Date().toLocaleString()}`;

            const ownerId = config.get('telegram.ownerId') || config.get('telegram.chatId');
            const logChannel = config.get('telegram.logChannel');

            // Send to owner
            if (ownerId) {
                await this.telegramBot.sendMessage(ownerId, startMessage, {
                    parse_mode: 'Markdown'
                });
            }

            // Send to log channel
            if (logChannel && logChannel !== ownerId) {
                await this.telegramBot.sendMessage(logChannel, startMessage, {
                    parse_mode: 'Markdown'
                });
            }

            logger.info('🚀 Start message sent to Telegram');
        } catch (error) {
            logger.error('❌ Failed to send start message to Telegram:', error);
        }
    }

    // Enhanced presence management
    async sendPresence(jid, presenceType = 'available') {
        try {
            if (!this.whatsappBot?.sock || !config.get('telegram.features.presenceUpdates')) return;
            
            const now = Date.now();
            const lastUpdate = this.lastPresenceUpdate.get(jid) || 0;
            
            // Throttle presence updates
            if (now - lastUpdate < 1000) return;
            
            this.lastPresenceUpdate.set(jid, now);
            
            await this.whatsappBot.sock.sendPresenceUpdate(presenceType, jid);
            logger.debug(`👁️ Sent presence update: ${presenceType} to ${jid}`);
            
        } catch (error) {
            logger.debug('Failed to send presence:', error);
        }
    }

    async sendTypingPresence(jid) {
        try {
            if (!this.whatsappBot?.sock || !config.get('telegram.features.presenceUpdates')) return;
            
            await this.sendPresence(jid, 'composing');
            
            // Clear any existing timeout
            if (this.presenceTimeout) {
                clearTimeout(this.presenceTimeout);
            }
            
            // Auto-stop typing after 3 seconds
            this.presenceTimeout = setTimeout(async () => {
                try {
                    await this.sendPresence(jid, 'paused');
                } catch (error) {
                    logger.debug('Failed to send paused presence:', error);
                }
            }, 3000);
            
        } catch (error) {
            logger.debug('Failed to send typing presence:', error);
        }
    }

    // FIXED: Check if topic exists in current session
    async verifyTopicExists(topicId) {
        try {
            const chatId = config.get('telegram.chatId');
            
            // Try to send a test message and immediately delete it
            const testMsg = await this.telegramBot.sendMessage(chatId, '🔍', {
                message_thread_id: topicId
            });
            
            // If successful, delete the test message
            await this.telegramBot.deleteMessage(chatId, testMsg.message_id);
            return true;
            
        } catch (error) {
            // If error, topic doesn't exist
            return false;
        }
    }

    // FIXED: Recreate missing topics in current session
    async recreateMissingTopics() {
        try {
            logger.info('🔄 Checking for missing topics...');
            const toRecreate = [];
            
            for (const [jid, topicId] of this.chatMappings.entries()) {
                const exists = await this.verifyTopicExists(topicId);
                if (exists === false) { // Explicitly check for false
                    logger.warn(`🗑️ Topic ${topicId} for ${jid} was deleted, will recreate...`);
                    toRecreate.push(jid);
                }
                // Small delay to avoid rate limits
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            
            for (const jid of toRecreate) {
                // Remove old mapping
                this.chatMappings.delete(jid);
                await this.collection.deleteOne({ 
                    type: 'chat', 
                    'data.whatsappJid': jid 
                });
                
                // Create new topic
                const dummyMsg = {
                    key: { 
                        remoteJid: jid, 
                        participant: jid.endsWith('@g.us') ? jid : jid 
                    }
                };
                await this.getOrCreateTopic(jid, dummyMsg);
                
                logger.info(`✅ Recreated topic for ${jid}`);
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            
            if (toRecreate.length > 0) {
                logger.info(`✅ Recreated ${toRecreate.length} missing topics`);
            }
            
        } catch (error) {
            logger.error('❌ Error recreating missing topics:', error);
        }
    }

    async syncMessage(whatsappMsg, text) {
        if (!this.telegramBot || !config.get('telegram.enabled')) return;

        const sender = whatsappMsg.key.remoteJid;
        const participant = whatsappMsg.key.participant || sender;
        const isFromMe = whatsappMsg.key.fromMe;
        
        // Handle status messages
        if (sender === 'status@broadcast') {
            await this.handleStatusMessage(whatsappMsg, text);
            return;
        }
        
        if (isFromMe) {
            const existingTopicId = this.chatMappings.get(sender);
            if (existingTopicId) {
                const telegramMessageId = await this.syncOutgoingMessage(whatsappMsg, text, existingTopicId, sender);
                if (whatsappMsg.key.id && telegramMessageId) {
                    await this.saveMessageMapping(whatsappMsg.key.id, telegramMessageId);
                }
            }
            return;
        }
        
        await this.createUserMapping(participant, whatsappMsg);
        const topicId = await this.getOrCreateTopic(sender, whatsappMsg);
        
        let telegramMessageId = null;
        if (whatsappMsg.message?.ptvMessage || (whatsappMsg.message?.videoMessage?.ptv)) {
            telegramMessageId = await this.handleWhatsAppMedia(whatsappMsg, 'video_note', topicId);
        } else if (whatsappMsg.message?.imageMessage) {
            telegramMessageId = await this.handleWhatsAppMedia(whatsappMsg, 'image', topicId);
        } else if (whatsappMsg.message?.videoMessage) {
            telegramMessageId = await this.handleWhatsAppMedia(whatsappMsg, 'video', topicId);
        } else if (whatsappMsg.message?.audioMessage) {
            telegramMessageId = await this.handleWhatsAppMedia(whatsappMsg, 'audio', topicId);
        } else if (whatsappMsg.message?.documentMessage) {
            telegramMessageId = await this.handleWhatsAppMedia(whatsappMsg, 'document', topicId);
        } else if (whatsappMsg.message?.stickerMessage) {
            telegramMessageId = await this.handleWhatsAppMedia(whatsappMsg, 'sticker', topicId);
        } else if (whatsappMsg.message?.locationMessage) { 
            telegramMessageId = await this.handleWhatsAppLocation(whatsappMsg, topicId);
        } else if (whatsappMsg.message?.contactMessage) { 
            telegramMessageId = await this.handleWhatsAppContact(whatsappMsg, topicId);
        } else if (text) {
            let messageText = text;
            if (sender.endsWith('@g.us') && participant !== sender) {
                const senderPhone = participant.split('@')[0];
                const senderName = this.contactMappings.get(senderPhone) || senderPhone;
                messageText = `👤 ${senderName}:\n${text}`;
            }
            telegramMessageId = await this.sendSimpleMessage(topicId, messageText, sender);
        }

        if (whatsappMsg.key?.id && telegramMessageId) {
            await this.saveMessageMapping(whatsappMsg.key.id, telegramMessageId);
        }

        if (whatsappMsg.key?.id && config.get('telegram.features.readReceipts') !== false) {
            this.queueMessageForReadReceipt(sender, whatsappMsg.key);
        }
    }

    // FIXED: Handle status messages properly
    async handleStatusMessage(whatsappMsg, text) {
        try {
            if (!config.get('telegram.features.statusSync')) return;
            
            const participant = whatsappMsg.key.participant;
            const phone = participant.split('@')[0];
            const contactName = this.contactMappings.get(phone) || `+${phone}`;
            
            // Get or create status topic
            const topicId = await this.getOrCreateTopic('status@broadcast', whatsappMsg);
            if (!topicId) return;
            
            // Create single status message with all info
            let statusText = `📱 *Status from ${contactName}* (+${phone})\n`;
            statusText += `⏰ ${new Date().toLocaleString()}\n\n`;
            
            if (text) {
                statusText += text;
            }
            
            const chatId = config.get('telegram.chatId');
            
            // Handle media status
            const mediaType = this.getMediaType(whatsappMsg);
            let sentMsg;
            if (mediaType && mediaType !== 'text') {
                sentMsg = await this.forwardStatusMedia(whatsappMsg, topicId, statusText, mediaType);
            } else {
                // Send text status
                sentMsg = await this.telegramBot.sendMessage(chatId, statusText, {
                    message_thread_id: topicId,
                    parse_mode: 'Markdown'
                });
            }
            
            // Store mapping for status reply
            if (sentMsg) {
                this.statusMessageMapping.set(sentMsg.message_id, whatsappMsg.key);
            }
            
            // Auto-view status if enabled
            if (config.get('features.autoViewStatus')) {
                await this.whatsappBot.sock.readMessages([whatsappMsg.key]);
            }
            
        } catch (error) {
            logger.error('❌ Error handling status message:', error);
        }
    }

    async forwardStatusMedia(whatsappMsg, topicId, caption, mediaType) {
        try {
            const stream = await downloadContentFromMessage(
                whatsappMsg.message[`${mediaType}Message`], 
                mediaType
            );
            
            const buffer = await this.streamToBuffer(stream);
            const chatId = config.get('telegram.chatId');
            
            let sentMsg;
            switch (mediaType) {
                case 'image':
                    sentMsg = await this.telegramBot.sendPhoto(chatId, buffer, {
                        message_thread_id: topicId,
                        caption: caption,
                        parse_mode: 'Markdown'
                    });
                    break;
                case 'video':
                    sentMsg = await this.telegramBot.sendVideo(chatId, buffer, {
                        message_thread_id: topicId,
                        caption: caption,
                        parse_mode: 'Markdown'
                    });
                    break;
                case 'audio':
                    sentMsg = await this.telegramBot.sendAudio(chatId, buffer, {
                        message_thread_id: topicId,
                        caption: caption,
                        parse_mode: 'Markdown'
                    });
                    break;
                default:
                    logger.warn(`Unsupported media type for status: ${mediaType}`);
                    return null;
            }
            
            return sentMsg;
            
        } catch (error) {
            logger.error('❌ Error forwarding status media:', error);
            // Fallback to text
            const sentMsg = await this.telegramBot.sendMessage(config.get('telegram.chatId'), caption, {
                message_thread_id: topicId,
                parse_mode: 'Markdown'
            });
            return sentMsg;
        }
    }

    getMediaType(msg) {
        if (msg.message?.imageMessage) return 'image';
        if (msg.message?.videoMessage) return 'video';
        if (msg.message?.audioMessage) return 'audio';
        if (msg.message?.documentMessage) return 'document';
        if (msg.message?.stickerMessage) return 'sticker';
        if (msg.message?.locationMessage) return 'location';
        if (msg.message?.contactMessage) return 'contact';
        return 'text';
    }

    async syncOutgoingMessage(whatsappMsg, text, topicId, sender) {
        try {
            let telegramMessageId = null;
            if (whatsappMsg.message?.ptvMessage || (whatsappMsg.message?.videoMessage?.ptv)) {
                telegramMessageId = await this.handleWhatsAppMedia(whatsappMsg, 'video_note', topicId, true);
            } else if (whatsappMsg.message?.imageMessage) {
                telegramMessageId = await this.handleWhatsAppMedia(whatsappMsg, 'image', topicId, true);
            } else if (whatsappMsg.message?.videoMessage) {
                telegramMessageId = await this.handleWhatsAppMedia(whatsappMsg, 'video', topicId, true);
            } else if (whatsappMsg.message?.audioMessage) {
                telegramMessageId = await this.handleWhatsAppMedia(whatsappMsg, 'audio', topicId, true);
            } else if (whatsappMsg.message?.documentMessage) {
                telegramMessageId = await this.handleWhatsAppMedia(whatsappMsg, 'document', topicId, true);
            } else if (whatsappMsg.message?.stickerMessage) {
                telegramMessageId = await this.handleWhatsAppMedia(whatsappMsg, 'sticker', topicId, true);
            } else if (whatsappMsg.message?.locationMessage) { 
                telegramMessageId = await this.handleWhatsAppLocation(whatsappMsg, topicId, true);
            } else if (whatsappMsg.message?.contactMessage) { 
                telegramMessageId = await this.handleWhatsAppContact(whatsappMsg, topicId, true);
            } else if (text) {
                const messageText = `📤 You: ${text}`;
                telegramMessageId = await this.sendSimpleMessage(topicId, messageText, sender);
            }
            return telegramMessageId;
        } catch (error) {
            logger.error('❌ Failed to sync outgoing message:', error);
            return null;
        }
    }

    queueMessageForReadReceipt(chatJid, messageKey) {
        if (!config.get('telegram.features.readReceipts')) return;
        
        if (!this.messageQueue.has(chatJid)) {
            this.messageQueue.set(chatJid, []);
        }
        
        this.messageQueue.get(chatJid).push(messageKey);
        
        setTimeout(() => {
            this.processReadReceipts(chatJid);
        }, 2000);
    }

    async processReadReceipts(chatJid) {
        try {
            const messages = this.messageQueue.get(chatJid);
            if (!messages || messages.length === 0) return;
            
            if (this.whatsappBot?.sock) {
                await this.whatsappBot.sock.readMessages(messages);
                logger.debug(`📖 Marked ${messages.length} messages as read in ${chatJid}`);
            }
            
            this.messageQueue.set(chatJid, []);
        } catch (error) {
            logger.debug('Failed to send read receipts:', error);
        }
    }

    async createUserMapping(participant, whatsappMsg) {
        if (this.userMappings.has(participant)) {
            const userData = this.userMappings.get(participant);
            userData.messageCount = (userData.messageCount || 0) + 1;
            await this.saveUserMapping(participant, userData);
            return;
        }

        let userName = null;
        let userPhone = participant.split('@')[0];
        
        try {
            if (this.contactMappings.has(userPhone)) {
                userName = this.contactMappings.get(userPhone);
            }
        } catch (error) {
            logger.debug('Could not fetch contact info:', error);
        }

        const userData = {
            name: userName,
            phone: userPhone,
            firstSeen: new Date(),
            messageCount: 1
        };

        await this.saveUserMapping(participant, userData);
        logger.debug(`👤 Created user mapping: ${userName || userPhone} (${userPhone})`);
    }

    async getOrCreateTopic(chatJid, whatsappMsg) {
        // Check if we have a mapping
        if (this.chatMappings.has(chatJid)) {
            const topicId = this.chatMappings.get(chatJid);
            
            // Verify topic still exists using the cache first
            let exists = this.topicVerificationCache.get(topicId);
            if (exists === undefined) { // Not in cache, verify with API
                exists = await this.verifyTopicExists(topicId);
                this.topicVerificationCache.set(topicId, exists);
            }

            if (exists) {
                return topicId;
            } else {
                // Topic was deleted, remove from mapping and recreate
                logger.warn(`🗑️ Topic ${topicId} for ${chatJid} was deleted, recreating...`);
                this.chatMappings.delete(chatJid);
                await this.collection.deleteOne({ 
                    type: 'chat', 
                    'data.whatsappJid': chatJid 
                });
                this.topicVerificationCache.delete(topicId); // Invalidate cache
            }
        }

        // Create new topic
        const chatId = config.get('telegram.chatId');
        if (!chatId || chatId.includes('YOUR_CHAT_ID')) {
            logger.error('❌ Telegram chat ID not configured');
            return null;
        }

        try {
            const isGroup = chatJid.endsWith('@g.us');
            const isStatus = chatJid === 'status@broadcast';
            const isCall = chatJid === 'call@broadcast';
            
            let topicName;
            let iconColor = 0x7ABA3C;
            
            if (isStatus) {
                topicName = `📊 Status Updates`;
                iconColor = 0xFF6B35;
            } else if (isCall) {
                topicName = `📞 Call Logs`;
                iconColor = 0xFF4757;
            } else if (isGroup) {
                try {
                    const groupMeta = await this.whatsappBot.sock.groupMetadata(chatJid);
                    topicName = `${groupMeta.subject}`;
                } catch (error) {
                    topicName = `Group Chat`;
                    logger.debug(`Could not fetch group metadata for ${chatJid}:`, error);
                }
                iconColor = 0x6FB9F0;
            } else {
                const phone = chatJid.split('@')[0];
                const contactName = this.contactMappings.get(phone) || `+${phone}`;
                topicName = contactName;
            }

            // Create the new forum topic
            const topic = await this.telegramBot.createForumTopic(chatId, topicName, { icon_color: iconColor });
            const topicId = topic.message_thread_id;
            
            await this.saveChatMapping(chatJid, topicId);
            this.topicVerificationCache.set(topicId, true); // Add to cache

            logger.info(`🆕 Created Telegram topic: ${topicName} (ID: ${topicId}) for ${chatJid}`);
            
            if (!isStatus && !isCall) {
                await this.sendWelcomeMessage(topicId, jid, isGroup, whatsappMsg);
            }
            
            return topicId;
        } catch (error) {
            logger.error('❌ Failed to create Telegram topic:', error);
            return null;
        }
    }

    async sendWelcomeMessage(topicId, jid, isGroup, whatsappMsg) {
        try {
            const chatId = config.get('telegram.chatId');
            const phone = jid.split('@')[0];
            const contactName = this.contactMappings.get(phone) || `+${phone}`;
            const participant = whatsappMsg.key.participant || jid;
            const userInfo = this.userMappings.get(participant);
            const handleName = whatsappMsg.pushName || userInfo?.name || 'Unknown';
            
            let welcomeText = '';
            if (isGroup) {
                try {
                    const groupMeta = await this.whatsappBot.sock.groupMetadata(jid);
                    welcomeText = `🏷️ **Group Information**\n\n` +
                                  `📝 **Name:** ${groupMeta.subject}\n` +
                                  `👥 **Participants:** ${groupMeta.participants.length}\n` +
                                  `🆔 **Group ID:** \`${jid}\`\n` +
                                  `📅 **Created:** ${new Date(groupMeta.creation * 1000).toLocaleDateString()}\n\n` +
                                  `💬 Messages from this group will appear here`;
                } catch (error) {
                    welcomeText = `🏷️ **Group Chat**\n\n💬 Messages from this group will appear here`;
                    logger.debug(`Could not fetch group metadata for ${jid}:`, error);
                }
            } else {
                // Get user status/bio
                let userStatus = '';
                try {
                    const status = await this.whatsappBot.sock.fetchStatus(jid);
                    if (status?.status) {
                        userStatus = `📝 **Status:** ${status.status}\n`;
                    }
                } catch (error) {
                    logger.debug(`Could not fetch status for ${jid}:`, error);
                }
                welcomeText = `👤 **Contact Information**\n\n` +
                              `📝 **Name:** ${contactName}\n` +
                              `📱 **Phone:** +${phone}\n` +
                              `🖐️ **Handle:** ${handleName}\n` +
                              userStatus +
                              `🆔 **WhatsApp ID:** \`${jid}\`\n` +
                              `📅 **First Contact:** ${new Date().toLocaleDateString()}\n\n` +
                              `💬 Messages with this contact will appear here`;
            }

            const sentMessage = await this.telegramBot.sendMessage(chatId, welcomeText, {
                message_thread_id: topicId,
                parse_mode: 'Markdown'
            });
            await this.telegramBot.pinChatMessage(chatId, sentMessage.message_id);
            await this.sendProfilePicture(topicId, jid, false);
        } catch (error) {
            logger.error('❌ Failed to send welcome message:', error);
        }
    }

    // FIXED: Profile picture sync to use DB
    async sendProfilePicture(topicId, jid, isUpdate = false) {
        try {
            if (!config.get('telegram.features.profilePicSync')) return;

            const profilePicUrl = await this.whatsappBot.sock.profilePictureUrl(jid, 'image');

            // Check against DB cache
            const cachedUrl = this.profilePicCache.get(jid);
            if (cachedUrl === profilePicUrl && isUpdate) {
                logger.debug(`📸 Profile picture for ${jid} is unchanged. Skipping update.`);
                return;
            }

            if (profilePicUrl) {
                const caption = isUpdate ? '📸 Profile picture updated' : '📸 Profile Picture';
                await this.telegramBot.sendPhoto(config.get('telegram.chatId'), profilePicUrl, {
                    message_thread_id: topicId,
                    caption: caption
                });
                await this.saveProfilePictureCache(jid, profilePicUrl); // Save to DB
            }
        } catch (error) {
            logger.debug('Could not send profile picture:', error);
        }
    }

    // FIXED: Call notification handling
    async handleCallNotification(callEvent) {
        if (!this.telegramBot || !config.get('telegram.features.callLogs')) return;

        const callerId = callEvent.from;
        const callKey = `${callerId}_${callEvent.id}`;

        if (this.activeCallNotifications.has(callKey)) return;
        this.activeCallNotifications.set(callKey, true);
        setTimeout(() => {
            this.activeCallNotifications.delete(callKey);
        }, 30000); // Keep notification active for 30 seconds to prevent duplicates

        try {
            const phone = callerId.split('@')[0];
            const callerName = this.contactMappings.get(phone) || `+${phone}`;
            
            const topicId = await this.getOrCreateTopic('call@broadcast', { key: { remoteJid: 'call@broadcast', participant: callerId } });
            if (!topicId) {
                logger.error('❌ Could not create call topic');
                return;
            }

            const callMessage = `📞 **Incoming Call**\n\n` +
                                `👤 **From:** ${callerName}\n` +
                                `📱 **Number:** +${phone}\n` +
                                `⏰ **Time:** ${new Date().toLocaleString()}\n` +
                                `📋 **Status:** ${callEvent.status || 'Incoming'}`;

            await this.telegramBot.sendMessage(config.get('telegram.chatId'), callMessage, {
                message_thread_id: topicId,
                parse_mode: 'Markdown'
            });
            logger.info(`📞 Sent call notification from ${callerName}`);
        } catch (error) {
            logger.error('❌ Error handling call notification:', error);
        }
    }

    async handleWhatsAppMedia(whatsappMsg, mediaType, topicId, isOutgoing = false) {
        try {
            logger.info(`📥 Processing ${mediaType} from WhatsApp`);
            
            let mediaMessage;
            let fileName = `media_${Date.now()}`;
            let caption = this.extractText(whatsappMsg); // Extracts text from caption or quoted message
            
            // Handle quoted messages in media
            const quotedMessage = this.extractQuotedMessage(whatsappMsg);
            if (quotedMessage) {
                caption = quotedMessage + '\n\n' + caption;
            }

            switch (mediaType) {
                case 'image':
                    mediaMessage = whatsappMsg.message.imageMessage;
                    fileName += '.jpg';
                    break;
                case 'video':
                    mediaMessage = whatsappMsg.message.videoMessage;
                    fileName += '.mp4';
                    break;
                case 'video_note':
                    mediaMessage = whatsappMsg.message.ptvMessage || whatsappMsg.message.videoMessage;
                    fileName += '.mp4';
                    break;
                case 'audio':
                    mediaMessage = whatsappMsg.message.audioMessage;
                    fileName += '.ogg';
                    break;
                case 'document':
                    mediaMessage = whatsappMsg.message.documentMessage;
                    fileName = mediaMessage.fileName || `document_${Date.now()}`;
                    break;
                case 'sticker':
                    mediaMessage = whatsappMsg.message.stickerMessage;
                    fileName += '.webp';
                    break;
            }

            if (!mediaMessage) {
                logger.error(`❌ No media message found for ${mediaType}`);
                return null;
            }
            
            // Handle View Once messages
            if (mediaMessage.viewOnce) {
                caption = `_View Once ${mediaType.toUpperCase()}_\n\n` + caption;
                // Add a warning that it's view once and won't be seen on WhatsApp again
                await this.telegramBot.sendMessage(config.get('telegram.chatId'), `*⚠️ View Once ${mediaType.toUpperCase()} Received*\n\nThis media can only be viewed once. Once viewed here, it cannot be seen on WhatsApp.`, {
                    message_thread_id: topicId,
                    parse_mode: 'Markdown'
                });
            }

            logger.info(`📥 Downloading ${mediaType} from WhatsApp: ${fileName}`);
            
            const downloadType = mediaType === 'sticker' ? 'sticker' : mediaType === 'video_note' ? 'video' : mediaType;
            const stream = await downloadContentFromMessage(mediaMessage, downloadType);

            if (!stream) {
                logger.error(`❌ Failed to get stream for ${mediaType}`);
                return null;
            }

            const buffer = await this.streamToBuffer(stream);

            if (!buffer || buffer.length === 0) {
                logger.error(`❌ Empty buffer for ${mediaType}`);
                return null;
            }

            const filePath = path.join(this.tempDir, fileName);
            await fs.writeFile(filePath, buffer);
            logger.info(`💾 Saved ${mediaType} to: ${filePath} (${buffer.length} bytes)`);

            const sender = whatsappMsg.key.remoteJid;
            const participant = whatsappMsg.key.participant || sender;
            const senderName = (sender.endsWith('@g.us') && !isOutgoing) ? 
                               (this.contactMappings.get(participant.split('@')[0]) || participant.split('@')[0]) + ':\n' : 
                               (isOutgoing ? '📤 You:\n' : '');

            let telegramMsg;
            const messageOptions = {
                message_thread_id: topicId,
                caption: senderName + caption,
                parse_mode: 'Markdown'
            };

            // Remove file after sending
            const deleteFile = async () => {
                try {
                    await fs.unlink(filePath);
                    logger.debug(`🗑️ Deleted temp file: ${filePath}`);
                } catch (err) {
                    logger.debug(`Could not delete temp file ${filePath}:`, err);
                }
            };
            
            switch (mediaType) {
                case 'image':
                    telegramMsg = await this.telegramBot.sendPhoto(config.get('telegram.chatId'), filePath, messageOptions);
                    break;
                case 'video':
                case 'video_note': // Telegram handles video notes as regular videos
                    telegramMsg = await this.telegramBot.sendVideo(config.get('telegram.chatId'), filePath, messageOptions);
                    break;
                case 'audio':
                    telegramMsg = await this.telegramBot.sendAudio(config.get('telegram.chatId'), filePath, messageOptions);
                    break;
                case 'document':
                    telegramMsg = await this.telegramBot.sendDocument(config.get('telegram.chatId'), filePath, messageOptions);
                    break;
                case 'sticker':
                    telegramMsg = await this.telegramBot.sendSticker(config.get('telegram.chatId'), filePath, {
                        message_thread_id: topicId
                    });
                    break;
                default:
                    logger.warn(`Unsupported media type: ${mediaType}`);
                    await deleteFile(); // Delete unsupported file
                    return null;
            }

            await deleteFile(); // Delete the file after sending
            logger.info(`⬆️ Sent ${mediaType} to Telegram: ${telegramMsg.message_id}`);
            return telegramMsg.message_id;

        } catch (error) {
            logger.error(`❌ Failed to handle WhatsApp ${mediaType}:`, error);
            return null;
        }
    }

    async handleWhatsAppLocation(whatsappMsg, topicId, isOutgoing = false) {
        try {
            logger.info('📍 Processing location from WhatsApp');
            const location = whatsappMsg.message.locationMessage;
            if (!location) {
                logger.error('❌ No location message found');
                return null;
            }

            const sender = whatsappMsg.key.remoteJid;
            const participant = whatsappMsg.key.participant || sender;
            const senderName = (sender.endsWith('@g.us') && !isOutgoing) ? 
                               (this.contactMappings.get(participant.split('@')[0]) || participant.split('@')[0]) + ':\n' : 
                               (isOutgoing ? '📤 You:\n' : '');

            const caption = this.extractText(whatsappMsg);
            const quotedMessage = this.extractQuotedMessage(whatsappMsg);
            let fullCaption = senderName;
            if (quotedMessage) {
                fullCaption += quotedMessage + '\n\n';
            }
            if (caption) {
                fullCaption += caption;
            } else if (!quotedMessage) {
                fullCaption += `Location shared by ${isOutgoing ? 'You' : this.contactMappings.get(participant.split('@')[0]) || participant.split('@')[0]}`;
            }

            const telegramMsg = await this.telegramBot.sendLocation(
                config.get('telegram.chatId'),
                location.degreesLatitude,
                location.degreesLongitude,
                {
                    message_thread_id: topicId,
                    caption: fullCaption,
                    parse_mode: 'Markdown'
                }
            );
            logger.info(`⬆️ Sent location to Telegram: ${telegramMsg.message_id}`);
            return telegramMsg.message_id;

        } catch (error) {
            logger.error('❌ Failed to handle WhatsApp location:', error);
            return null;
        }
    }

    async handleWhatsAppContact(whatsappMsg, topicId, isOutgoing = false) {
        try {
            logger.info('📞 Processing contact from WhatsApp');
            const contact = whatsappMsg.message.contactMessage;
            if (!contact) {
                logger.error('❌ No contact message found');
                return null;
            }

            const sender = whatsappMsg.key.remoteJid;
            const participant = whatsappMsg.key.participant || sender;
            const senderName = (sender.endsWith('@g.us') && !isOutgoing) ? 
                               (this.contactMappings.get(participant.split('@')[0]) || participant.split('@')[0]) + ':\n' : 
                               (isOutgoing ? '📤 You:\n' : '');

            const caption = this.extractText(whatsappMsg);
            const quotedMessage = this.extractQuotedMessage(whatsappMsg);
            let fullCaption = senderName;
            if (quotedMessage) {
                fullCaption += quotedMessage + '\n\n';
            }
            if (caption) {
                fullCaption += caption;
            }

            const contactVcard = contact.vcard;
            const contactName = contact.displayName || 'Unknown Contact';

            const telegramMsg = await this.telegramBot.sendContact(
                config.get('telegram.chatId'),
                contactVcard,
                contactName,
                {
                    message_thread_id: topicId,
                    caption: fullCaption,
                    parse_mode: 'Markdown'
                }
            );
            logger.info(`⬆️ Sent contact to Telegram: ${telegramMsg.message_id}`);
            return telegramMsg.message_id;

        } catch (error) {
            logger.error('❌ Failed to handle WhatsApp contact:', error);
            return null;
        }
    }

    async sendSimpleMessage(topicId, text, whatsappJid) {
        try {
            // Check if this is an @all or @everyone mention
            let mentions = [];
            if (whatsappJid.endsWith('@g.us') && (text.includes('@all') || text.includes('@everyone'))) {
                try {
                    const groupMeta = await this.whatsappBot.sock.groupMetadata(whatsappJid);
                    mentions = groupMeta.participants.map(p => p.id);
                    logger.debug(`👥 Detected @all/@everyone mention. Mentions: ${mentions.length}`);
                } catch (error) {
                    logger.warn(`Could not fetch group metadata for @all/@everyone mention:`, error);
                }
            } else {
                // Basic mention parsing for Telegram mentions (e.g., @username)
                // This would require mapping Telegram usernames to WhatsApp JIDs
                // For now, this is a placeholder. Full implementation needs more context.
                // const telegramMentions = text.match(/@(\w+)/g);
                // if (telegramMentions) {
                //     for (const mention of telegramMentions) {
                //         // Lookup WhatsApp JID for this Telegram username
                //         const waJid = await this.getWhatsappJidFromTelegramUsername(mention.substring(1));
                //         if (waJid) {
                //             mentions.push(waJid);
                //         }
                //     }
                // }
            }

            const sentMsg = await this.telegramBot.sendMessage(config.get('telegram.chatId'), text, {
                message_thread_id: topicId,
                parse_mode: 'Markdown',
                disable_web_page_preview: true,
                // These are for WhatsApp mentions, not Telegram.
                // We need to ensure the correct parsing is done for Telegram entities.
                // entities: mentions.length > 0 ? [{
                //     offset: 0, // Placeholder, needs actual offset
                //     length: text.length, // Placeholder, needs actual length
                //     type: 'mention'
                // }] : undefined
            });
            logger.info(`⬆️ Sent message to Telegram: ${sentMsg.message_id}`);
            return sentMsg.message_id;
        } catch (error) {
            logger.error('❌ Failed to send simple message to Telegram:', error);
            return null;
        }
    }

    // Helper to extract text from a WhatsApp message, including quoted messages and captions
    extractText(whatsappMsg) {
        if (whatsappMsg.message?.extendedTextMessage?.text) {
            return whatsappMsg.message.extendedTextMessage.text;
        }
        if (whatsappMsg.message?.imageMessage?.caption) {
            return whatsappMsg.message.imageMessage.caption;
        }
        if (whatsappMsg.message?.videoMessage?.caption) {
            return whatsappMsg.message.videoMessage.caption;
        }
        if (whatsappMsg.message?.documentMessage?.caption) {
            return whatsappMsg.message.documentMessage.caption;
        }
        if (whatsappMsg.message?.conversation) {
            return whatsappMsg.message.conversation;
        }
        return '';
    }

    // Helper to extract and format quoted message text
    extractQuotedMessage(whatsappMsg) {
        const quoted = whatsappMsg.message?.extendedTextMessage?.contextInfo?.quotedMessage ||
                       whatsappMsg.message?.imageMessage?.contextInfo?.quotedMessage ||
                       whatsappMsg.message?.videoMessage?.contextInfo?.quotedMessage ||
                       whatsappMsg.message?.documentMessage?.contextInfo?.quotedMessage;

        if (quoted) {
            let quotedText = '';
            if (quoted.extendedTextMessage?.text) {
                quotedText = quoted.extendedTextMessage.text;
            } else if (quoted.imageMessage) {
                quotedText = '[Image] ' + (quoted.imageMessage.caption || '');
            } else if (quoted.videoMessage) {
                quotedText = '[Video] ' + (quoted.videoMessage.caption || '');
            } else if (quoted.documentMessage) {
                quotedText = '[Document] ' + (quoted.documentMessage.fileName || '');
            } else if (quoted.stickerMessage) {
                quotedText = '[Sticker]';
            } else if (quoted.audioMessage) {
                quotedText = '[Audio]';
            } else if (quoted.locationMessage) {
                quotedText = '[Location]';
            } else if (quoted.contactMessage) {
                quotedText = '[Contact] ' + (quoted.contactMessage.displayName || '');
            } else {
                quotedText = '[Unsupported Quoted Message Type]';
            }
            // Limit quoted text length for readability
            if (quotedText.length > 100) {
                quotedText = quotedText.substring(0, 97) + '...';
            }
            return `> ${quotedText}\n\n`;
        }
        return '';
    }

    // Convert stream to buffer
    streamToBuffer(stream) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            stream.on('data', (chunk) => chunks.push(chunk));
            stream.on('end', () => resolve(Buffer.concat(chunks)));
            stream.on('error', reject);
        });
    }

    async handleTelegramMessage(msg) {
        const chatId = config.get('telegram.chatId');
        if (msg.chat.id !== chatId) return;

        logger.info(`⬇️ Received Telegram message (ID: ${msg.message_id}) in topic ${msg.message_thread_id}`);

        const whatsappJid = Array.from(this.chatMappings.entries())
            .find(([jid, topicId]) => topicId === msg.message_thread_id)?.[0];

        if (!whatsappJid) {
            logger.warn(`❌ Could not find WhatsApp JID for Telegram topic ID: ${msg.message_thread_id}`);
            return;
        }

        // Handle replies (quoted messages and reactions)
        if (msg.reply_to_message) {
            // Check if it's a reaction (single emoji reply)
            if (msg.text && this.isSingleEmoji(msg.text) && msg.message_thread_id === msg.reply_to_message.message_thread_id) {
                await this.handleTelegramReaction(msg, whatsappJid);
                return;
            }
            // Check if it's a status reply
            if (this.statusMessageMapping.has(msg.reply_to_message.message_id)) {
                await this.handleStatusReply(msg, whatsappJid);
                return;
            }
        }
        
        // Handle media messages from Telegram
        let whatsappMessage;
        if (msg.photo) {
            whatsappMessage = await this.handleTelegramMedia(msg, 'photo', whatsappJid);
        } else if (msg.video) {
            whatsappMessage = await this.handleTelegramMedia(msg, 'video', whatsappJid);
        } else if (msg.audio) {
            whatsappMessage = await this.handleTelegramMedia(msg, 'audio', whatsappJid);
        } else if (msg.document) {
            whatsappMessage = await this.handleTelegramMedia(msg, 'document', whatsappJid);
        } else if (msg.sticker) {
            whatsappMessage = await this.handleTelegramMedia(msg, 'sticker', whatsappJid);
        } else if (msg.location) {
            whatsappMessage = await this.handleTelegramLocation(msg, whatsappJid);
        } else if (msg.contact) {
            whatsappMessage = await this.handleTelegramContact(msg, whatsappJid);
        } else if (msg.text) {
            whatsappMessage = await this.sendWhatsAppMessage(msg, whatsappJid);
        } else {
            logger.info(`🤷‍♀️ Unsupported Telegram message type: ${JSON.stringify(msg)}`);
        }

        // Save mapping for messages sent from Telegram to WhatsApp
        if (whatsappMessage?.key?.id) {
            await this.saveMessageMapping(whatsappMessage.key.id, msg.message_id);
        }
    }

    isSingleEmoji(text) {
        const emojiRegex = /^(\p{Emoji_Modifier_Base}|\p{Emoji_Presentation}|\p{Emoji}\p{Emoji_Modifier}*|\p{Emoji_Component})+$/u;
        return text.length <= 5 && emojiRegex.test(text); // Limit length to avoid false positives
    }

    async handleTelegramReaction(msg, whatsappJid) {
        const repliedToMsgId = msg.reply_to_message.message_id;
        const whatsappQuotedKey = await this.getWhatsappKeyFromTelegramMessageId(repliedToMsgId);

        if (!whatsappQuotedKey) {
            logger.warn(`Could not find WhatsApp key for replied Telegram message ID: ${repliedToMsgId}`);
            await this.telegramBot.sendMessage(msg.chat.id, '❌ Could not apply reaction. Original WhatsApp message not found.', {
                message_thread_id: msg.message_thread_id,
                reply_to_message_id: msg.message_id
            });
            return;
        }

        try {
            const reactionEmoji = msg.text;
            await this.whatsappBot.sock.sendMessage(whatsappJid, {
                react: {
                    text: reactionEmoji,
                    key: whatsappQuotedKey // Key of the message being reacted to
                }
            });
            logger.info(`↔️ Sent reaction '${reactionEmoji}' to WhatsApp for message ${whatsappQuotedKey}`);
            // Delete the Telegram reaction message after sending it to WhatsApp
            await this.telegramBot.deleteMessage(msg.chat.id, msg.message_id);
        } catch (error) {
            logger.error('❌ Failed to send WhatsApp reaction:', error);
            await this.telegramBot.sendMessage(msg.chat.id, '❌ Failed to send reaction to WhatsApp.', {
                message_thread_id: msg.message_thread_id,
                reply_to_message_id: msg.message_id
            });
        }
    }

    async handleStatusReply(msg, whatsappJid) {
        try {
            const repliedToMsgId = msg.reply_to_message.message_id;
            const originalStatusKey = this.statusMessageMapping.get(repliedToMsgId);

            if (!originalStatusKey) {
                logger.warn(`Could not find original WhatsApp status key for Telegram message ID: ${repliedToMsgId}`);
                await this.telegramBot.sendMessage(msg.chat.id, '❌ Could not reply to status. Original status not found.', {
                    message_thread_id: msg.message_thread_id,
                    reply_to_message_id: msg.message_id
                });
                return;
            }

            const text = msg.text || msg.caption || ''; // Get text from message or caption
            
            await this.whatsappBot.sock.sendMessage(originalStatusKey.remoteJid, {
                text: text,
                quoted: originalStatusKey,
                participant: originalStatusKey.participant // The participant whose status is being replied to
            });
            logger.info(`↩️ Sent reply to WhatsApp status from ${originalStatusKey.participant} via Telegram message ${msg.message_id}`);
        } catch (error) {
            logger.error('❌ Failed to handle Telegram status reply:', error);
            await this.telegramBot.sendMessage(msg.chat.id, '❌ Failed to send reply to WhatsApp status.', {
                message_thread_id: msg.message_thread_id,
                reply_to_message_id: msg.message_id
            });
        }
    }


    async handleTelegramMedia(msg, mediaType, whatsappJid) {
        let fileId;
        let caption = msg.caption || '';
        let mimeType;

        if (msg.photo) {
            fileId = msg.photo[msg.photo.length - 1].file_id; // Get the largest photo
            mimeType = 'image/jpeg';
        } else if (msg.video) {
            fileId = msg.video.file_id;
            mimeType = msg.video.mime_type;
        } else if (msg.audio) {
            fileId = msg.audio.file_id;
            mimeType = msg.audio.mime_type;
        } else if (msg.document) {
            fileId = msg.document.file_id;
            mimeType = msg.document.mime_type;
            caption = msg.document.file_name || caption; // Use file name as caption if available
        } else if (msg.sticker) {
            fileId = msg.sticker.file_id;
            mimeType = 'image/webp'; // Stickers are webp
        }

        if (!fileId) {
            logger.error(`❌ No file_id found for Telegram ${mediaType} message.`);
            return null;
        }

        try {
            const fileLink = await this.telegramBot.getFileLink(fileId);
            const response = await axios({
                method: 'get',
                url: fileLink,
                responseType: 'arraybuffer'
            });
            const buffer = Buffer.from(response.data);

            let whatsappMessage;
            const messageOptions = {
                caption: caption,
                ptt: mediaType === 'audio' && (mimeType === 'audio/ogg' || mimeType === 'audio/mpeg'), // Mark as Push To Talk if audio
            };

            // Handle quoted messages in Telegram media
            if (msg.reply_to_message) {
                const quotedMsgId = msg.reply_to_message.message_id;
                const whatsappQuotedKey = await this.getWhatsappKeyFromTelegramMessageId(quotedMsgId);
                if (whatsappQuotedKey) {
                    messageOptions.quoted = whatsappQuotedKey;
                } else {
                    logger.warn(`Could not find WhatsApp key for replied Telegram message ID: ${quotedMsgId}`);
                }
            }
            
            // Handle @all/@everyone mentions
            let mentions = [];
            if (whatsappJid.endsWith('@g.us')) {
                const textToCheck = msg.text || msg.caption || '';
                if (textToCheck.includes('@all') || textToCheck.includes('@everyone')) {
                    try {
                        const groupMeta = await this.whatsappBot.sock.groupMetadata(whatsappJid);
                        mentions = groupMeta.participants.map(p => p.id);
                        logger.debug(`👥 Detected @all/@everyone mention in Telegram media. Mentions: ${mentions.length}`);
                    } catch (error) {
                        logger.warn(`Could not fetch group metadata for @all/@everyone mention in media:`, error);
                    }
                }
            }
            if (mentions.length > 0) {
                messageOptions.mentions = mentions;
            }

            switch (mediaType) {
                case 'photo':
                    whatsappMessage = await this.whatsappBot.sock.sendMessage(whatsappJid, { image: buffer, ...messageOptions });
                    break;
                case 'video':
                    whatsappMessage = await this.whatsappBot.sock.sendMessage(whatsappJid, { video: buffer, ...messageOptions });
                    break;
                case 'audio':
                    whatsappMessage = await this.whatsappBot.sock.sendMessage(whatsappJid, { audio: buffer, mimetype: mimeType, ...messageOptions });
                    break;
                case 'document':
                    whatsappMessage = await this.whatsappBot.sock.sendMessage(whatsappJid, { document: buffer, fileName: caption, mimetype: mimeType, ...messageOptions });
                    break;
                case 'sticker':
                    // Convert WebP to a format WhatsApp can handle better if needed, or send as is
                    // Baileys typically handles WebP stickers directly
                    whatsappMessage = await this.whatsappBot.sock.sendMessage(whatsappJid, { sticker: buffer, ...messageOptions });
                    break;
                default:
                    logger.warn(`Unsupported Telegram media type for WhatsApp: ${mediaType}`);
                    return null;
            }
            logger.info(`⬆️ Sent ${mediaType} to WhatsApp: ${whatsappMessage.key.id}`);
            return whatsappMessage;
        } catch (error) {
            logger.error(`❌ Failed to handle Telegram ${mediaType}:`, error);
            await this.telegramBot.sendMessage(msg.chat.id, `❌ Failed to send ${mediaType} to WhatsApp.`, {
                message_thread_id: msg.message_thread_id,
                reply_to_message_id: msg.message_id
            });
            return null;
        }
    }

    async handleTelegramLocation(msg, whatsappJid) {
        try {
            logger.info('📍 Processing location from Telegram');
            const location = msg.location;
            if (!location) {
                logger.error('❌ No location data found in Telegram message.');
                return null;
            }

            const messageOptions = {};
            if (msg.reply_to_message) {
                const quotedMsgId = msg.reply_to_message.message_id;
                const whatsappQuotedKey = await this.getWhatsappKeyFromTelegramMessageId(quotedMsgId);
                if (whatsappQuotedKey) {
                    messageOptions.quoted = whatsappQuotedKey;
                } else {
                    logger.warn(`Could not find WhatsApp key for replied Telegram message ID: ${quotedMsgId}`);
                }
            }

            const whatsappMessage = await this.whatsappBot.sock.sendMessage(whatsappJid, {
                location: {
                    degreesLatitude: location.latitude,
                    degreesLongitude: location.longitude
                },
                ...messageOptions
            });
            logger.info(`⬆️ Sent location to WhatsApp: ${whatsappMessage.key.id}`);
            return whatsappMessage;
        } catch (error) {
            logger.error('❌ Failed to handle Telegram location:', error);
            await this.telegramBot.sendMessage(msg.chat.id, '❌ Failed to send location to WhatsApp.', {
                message_thread_id: msg.message_thread_id,
                reply_to_message_id: msg.message_id
            });
            return null;
        }
    }

    async handleTelegramContact(msg, whatsappJid) {
        try {
            logger.info('📞 Processing contact from Telegram');
            const contact = msg.contact;
            if (!contact || !contact.phone_number) {
                logger.error('❌ No contact data or phone number found in Telegram message.');
                return null;
            }

            // Create a simple vCard
            const vcard = `BEGIN:VCARD\\nVERSION:3.0\\nFN:${contact.first_name || ''} ${contact.last_name || ''}\\nTEL;type=CELL:${contact.phone_number}\\nEND:VCARD`;

            const messageOptions = {};
            if (msg.reply_to_message) {
                const quotedMsgId = msg.reply_to_message.message_id;
                const whatsappQuotedKey = await this.getWhatsappKeyFromTelegramMessageId(quotedMsgId);
                if (whatsappQuotedKey) {
                    messageOptions.quoted = whatsappQuotedKey;
                } else {
                    logger.warn(`Could not find WhatsApp key for replied Telegram message ID: ${quotedMsgId}`);
                }
            }

            const whatsappMessage = await this.whatsappBot.sock.sendMessage(whatsappJid, {
                contacts: {
                    displayName: `${contact.first_name || ''} ${contact.last_name || ''}`.trim(),
                    contacts: [{ vcard }]
                },
                ...messageOptions
            });
            logger.info(`⬆️ Sent contact to WhatsApp: ${whatsappMessage.key.id}`);
            return whatsappMessage;
        } catch (error) {
            logger.error('❌ Failed to handle Telegram contact:', error);
            await this.telegramBot.sendMessage(msg.chat.id, '❌ Failed to send contact to WhatsApp.', {
                message_thread_id: msg.message_thread_id,
                reply_to_message_id: msg.message_id
            });
            return null;
        }
    }

    async sendWhatsAppMessage(msg, whatsappJid) {
        const text = msg.text;
        const messageOptions = {
            linkPreview: config.get('telegram.features.linkPreview') !== false,
        };

        // Handle quoted messages
        if (msg.reply_to_message) {
            const quotedMsgId = msg.reply_to_message.message_id;
            const whatsappQuotedKey = await this.getWhatsappKeyFromTelegramMessageId(quotedMsgId);
            if (whatsappQuotedKey) {
                messageOptions.quoted = whatsappQuotedKey;
            } else {
                logger.warn(`Could not find WhatsApp key for replied Telegram message ID: ${quotedMsgId}`);
                await this.telegramBot.sendMessage(msg.chat.id, '⚠️ Could not quote original WhatsApp message.', {
                    message_thread_id: msg.message_thread_id,
                    reply_to_message_id: msg.message_id
                });
            }
        }

        // Handle @all/@everyone mentions
        let mentions = [];
        if (whatsappJid.endsWith('@g.us') && (text.includes('@all') || text.includes('@everyone'))) {
            try {
                const groupMeta = await this.whatsappBot.sock.groupMetadata(whatsappJid);
                mentions = groupMeta.participants.map(p => p.id);
                logger.debug(`👥 Detected @all/@everyone mention. Mentions: ${mentions.length}`);
            } catch (error) {
                logger.warn(`Could not fetch group metadata for @all/@everyone mention:`, error);
            }
        }

        if (mentions.length > 0) {
            messageOptions.mentions = mentions;
        }

        try {
            // Apply markdown formatting from Telegram to WhatsApp
            const formattedText = this.telegramToWhatsAppMarkdown(text, msg.entities);

            const whatsappMessage = await this.whatsappBot.sock.sendMessage(whatsappJid, {
                text: formattedText,
                ...messageOptions
            });
            logger.info(`⬆️ Sent message to WhatsApp: ${whatsappMessage.key.id}`);
            return whatsappMessage;
        } catch (error) {
            logger.error('❌ Failed to send message to WhatsApp:', error);
            await this.telegramBot.sendMessage(msg.chat.id, '❌ Failed to send message to WhatsApp.', {
                message_thread_id: msg.message_thread_id,
                reply_to_message_id: msg.message_id
            });
            return null;
        }
    }

    telegramToWhatsAppMarkdown(text, entities) {
        if (!entities || entities.length === 0) {
            return text;
        }

        let formattedText = '';
        let lastOffset = 0;

        // Sort entities by offset to process them in order
        entities.sort((a, b) => a.offset - b.offset);

        for (const entity of entities) {
            const { offset, length, type, url, user } = entity;

            // Add text before the current entity
            formattedText += text.substring(lastOffset, offset);

            const entityText = text.substring(offset, offset + length);
            let markdown = entityText;

            switch (type) {
                case 'bold':
                    markdown = `*${entityText}*`;
                    break;
                case 'italic':
                    markdown = `_${entityText}_`;
                    break;
                case 'code':
                    markdown = `\`${entityText}\``;
                    break;
                case 'pre': // Pre-formatted code block
                    markdown = `\`\`\`\n${entityText}\n\`\`\``;
                    break;
                case 'strikethrough':
                    markdown = `~${entityText}~`;
                    break;
                case 'underline': // WhatsApp doesn't directly support underline, convert to bold
                    markdown = `*${entityText}*`;
                    break;
                case 'text_link':
                    // WhatsApp doesn't support inline text links like Telegram.
                    // Option 1: Just the URL
                    markdown = url;
                    // Option 2: Text (URL)
                    // markdown = `${entityText} (${url})`;
                    break;
                case 'mention': // @username mentions
                    // WhatsApp handles JID mentions directly. For Telegram @mentions,
                    // if it's a known mapped user, could convert to WhatsApp JID.
                    // For now, keep as plain text or handle as part of @all logic
                    markdown = entityText; 
                    break;
                case 'url':
                    markdown = entityText; // URLs are typically auto-linked by WhatsApp
                    break;
                case 'hashtag':
                    markdown = entityText; // Hashtags are usually plain text
                    break;
                case 'cashtag':
                    markdown = entityText; // Cashtags are usually plain text
                    break;
                case 'bot_command':
                    markdown = entityText; // Bot commands are plain text
                    break;
                default:
                    markdown = entityText; // Fallback for unsupported types
            }
            formattedText += markdown;
            lastOffset = offset + length;
        }

        // Add any remaining text after the last entity
        formattedText += text.substring(lastOffset);
        return formattedText;
    }


    async syncWhatsAppConnection() {
        if (!this.whatsappBot?.sock) return;

        this.whatsappBot.sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                logger.info('Got QR code. Sending to Telegram...');
                await this.sendQRCode(qr);
            }
            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401;
                logger.info('WhatsApp connection closed!', 'reconnecting:', shouldReconnect);
                if (shouldReconnect) {
                    // Implement your reconnect logic here
                }
            } else if (connection === 'open') {
                logger.info('WhatsApp connection opened!');
                await this.sendStartMessage();
                // Ensure contacts and topics are synced upon successful connection
                await this.syncContacts();
                await this.recreateMissingTopics(); // Recreate topics if any were deleted while bot was offline
            }
        });

        this.whatsappBot.sock.ev.on('messages.upsert', async (m) => {
            if (m.messages && m.messages.length > 0) {
                for (const msg of m.messages) {
                    if (!msg.message) continue; // Ignore empty messages
                    
                    // Handle reactions (messageStubType === 36)
                    if (msg.messageStubType === 36 && msg.messageStubParameters) {
                        const reactionEmoji = msg.messageStubParameters[0];
                        const originalWhatsAppMessageId = msg.messageStubParameters[1];
                        if (originalWhatsAppMessageId && reactionEmoji) {
                            const telegramMessageId = await this.getTelegramMessageIdFromWhatsappKey(originalWhatsAppMessageId);
                            if (telegramMessageId) {
                                logger.info(`Received WhatsApp reaction '${reactionEmoji}' for message ${originalWhatsAppMessageId}. Applying to Telegram message ${telegramMessageId}`);
                                await this.setReaction(config.get('telegram.chatId'), telegramMessageId, reactionEmoji);
                            } else {
                                logger.warn(`Could not find Telegram message ID for WhatsApp message ${originalWhatsAppMessageId} to apply reaction.`);
                            }
                        }
                        continue; // Process reactions, then continue to next message
                    }

                    const messageText = this.extractText(msg); // Extracts text from message or caption
                    await this.syncMessage(msg, messageText);
                }
            }
        });

        this.whatsappBot.sock.ev.on('contacts.update', async (updates) => {
            for (const update of updates) {
                if (update.imgUrl || update.name) {
                    const jid = update.id;
                    const topicId = this.chatMappings.get(jid);
                    if (topicId) {
                        // Check if profile pic URL has actually changed from the DB cache
                        const currentProfilePicUrl = await this.whatsappBot.sock.profilePictureUrl(jid, 'image');
                        const cachedUrl = this.profilePicCache.get(jid);
                        
                        if (currentProfilePicUrl && currentProfilePicUrl !== cachedUrl) {
                            logger.info(`📸 Profile picture or name updated for ${jid}. Sending update to Telegram.`);
                            await this.sendProfilePicture(topicId, jid, true);
                        } else if (update.name) { // Only update topic name if name changed and pic didn't
                            await this.updateTopicNames(); // Re-run updateTopicNames to catch name changes
                        }
                    }
                }
            }
        });

        // FIXED: Call event handler
        this.whatsappBot.sock.ev.on('call', async (callEvents) => {
            for (const callEvent of callEvents) {
                await this.handleCallNotification(callEvent);
            }
        });

        logger.info('📱 WhatsApp event handlers set up for Telegram bridge');
    }
    
    async shutdown() {
        logger.info('🛑 Shutting down Telegram bridge...');
        
        if (this.presenceTimeout) {
            clearTimeout(this.presenceTimeout);
        }
        
        if (this.telegramBot) {
            try {
                await this.telegramBot.stopPolling();
                logger.info('📱 Telegram bot polling stopped.');
            } catch (error) {
                logger.debug('Error stopping Telegram polling:', error);
            }
        }
        
        try {
            await fs.emptyDir(this.tempDir);
            logger.info('🧹 Temp directory cleaned.');
        } catch (error) {
            logger.debug('Could not clean temp directory:', error);
        }
        
        logger.info('✅ Telegram bridge shutdown complete.');
    }
}

module.exports = TelegramBridge;
