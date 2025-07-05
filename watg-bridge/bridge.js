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
            /** profile‑picture caches */
        this.profilePicCache = new Map();          // jid   ➜ last URL sent to TG
        this._lastPicPush    = Object.create(null); // jid  ➜ last push ts (ms)

            /** quoted‑message bridges */
        this.tgToWa = new Map();   // Telegram message‑id  ➜  WhatsApp key
        this.waToTg = new Map();   // WhatsApp stanzaId    ➜  Telegram message‑id
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
            logger.info('📊 Database initialized for Telegram bridge (single collection: bridge)');
        } catch (error) {
            logger.error('❌ Failed to initialize database:', error);
        }
    }

    async loadMappingsFromDb() {
        try {
            const mappings = await this.collection.find({}).toArray();
            
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
                        name:  userData.name,
                        phone: userData.phone,
                        firstSeen: usersData.firstSeen,
                        messageCount: userData.messageCount || 0,
                        lastProfilePicUrl: userData.lastProfilePicUrl || null,
                        lastSeen: new Date()
                    }
                }
            },
            { upsert: true }
        );
        this.userMappings.set(whatsappId, userData);
        logger.debug(`✅ Saved user mapping: ${whatsappId} (${userData.name || userData.phone})`);
    } catch (err) {
        logger.error('❌ Failed to save user mapping:', err);
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
                if (!exists) {
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
                await this.syncOutgoingMessage(whatsappMsg, text, existingTopicId, sender);
            }
            return;
        }
        
        await this.createUserMapping(participant, whatsappMsg);
        const topicId = await this.getOrCreateTopic(sender, whatsappMsg);
        
        if (whatsappMsg.message?.ptvMessage || (whatsappMsg.message?.videoMessage?.ptv)) {
            await this.handleWhatsAppMedia(whatsappMsg, 'video_note', topicId);
        } else if (whatsappMsg.message?.imageMessage) {
            await this.handleWhatsAppMedia(whatsappMsg, 'image', topicId);
        } else if (whatsappMsg.message?.videoMessage) {
            await this.handleWhatsAppMedia(whatsappMsg, 'video', topicId);
        } else if (whatsappMsg.message?.audioMessage) {
            await this.handleWhatsAppMedia(whatsappMsg, 'audio', topicId);
        } else if (whatsappMsg.message?.documentMessage) {
            await this.handleWhatsAppMedia(whatsappMsg, 'document', topicId);
        } else if (whatsappMsg.message?.stickerMessage) {
            await this.handleWhatsAppMedia(whatsappMsg, 'sticker', topicId);
        } else if (whatsappMsg.message?.locationMessage) { 
            await this.handleWhatsAppLocation(whatsappMsg, topicId);
        } else if (whatsappMsg.message?.contactMessage) { 
            await this.handleWhatsAppContact(whatsappMsg, topicId);
        } else if (text) {
            let messageText = text;
            if (sender.endsWith('@g.us') && participant !== sender) {
                const senderPhone = participant.split('@')[0];
                const senderName = this.contactMappings.get(senderPhone) || senderPhone;
                messageText = `👤 ${senderName}:\n${text}`;
            }
            
            await this.sendSimpleMessage(topicId, messageText, sender);
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
            if (mediaType && mediaType !== 'text') {
                await this.forwardStatusMedia(whatsappMsg, topicId, statusText, mediaType);
            } else {
                // Send text status
                const sentMsg = await this.telegramBot.sendMessage(chatId, statusText, {
                    message_thread_id: topicId,
                    parse_mode: 'Markdown'
                });
                
                // Store mapping for status reply
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
            }
            
            // Store mapping for status reply
            if (sentMsg) {
                this.statusMessageMapping.set(sentMsg.message_id, whatsappMsg.key);
            }
            
        } catch (error) {
            logger.error('❌ Error forwarding status media:', error);
            // Fallback to text
            const sentMsg = await this.telegramBot.sendMessage(config.get('telegram.chatId'), caption, {
                message_thread_id: topicId,
                parse_mode: 'Markdown'
            });
            this.statusMessageMapping.set(sentMsg.message_id, whatsappMsg.key);
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
            if (whatsappMsg.message?.ptvMessage || (whatsappMsg.message?.videoMessage?.ptv)) {
                await this.handleWhatsAppMedia(whatsappMsg, 'video_note', topicId, true);
            } else if (whatsappMsg.message?.imageMessage) {
                await this.handleWhatsAppMedia(whatsappMsg, 'image', topicId, true);
            } else if (whatsappMsg.message?.videoMessage) {
                await this.handleWhatsAppMedia(whatsappMsg, 'video', topicId, true);
            } else if (whatsappMsg.message?.audioMessage) {
                await this.handleWhatsAppMedia(whatsappMsg, 'audio', topicId, true);
            } else if (whatsappMsg.message?.documentMessage) {
                await this.handleWhatsAppMedia(whatsappMsg, 'document', topicId, true);
            } else if (whatsappMsg.message?.stickerMessage) {
                await this.handleWhatsAppMedia(whatsappMsg, 'sticker', topicId, true);
            } else if (whatsappMsg.message?.locationMessage) { 
                await this.handleWhatsAppLocation(whatsappMsg, topicId, true);
            } else if (whatsappMsg.message?.contactMessage) { 
                await this.handleWhatsAppContact(whatsappMsg, topicId, true);
            } else if (text) {
                const messageText = `📤 You: ${text}`;
                await this.sendSimpleMessage(topicId, messageText, sender);
            }
        } catch (error) {
            logger.error('❌ Failed to sync outgoing message:', error);
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
            
            // Verify topic still exists
            const exists = await this.verifyTopicExists(topicId);
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

            const topic = await this.telegramBot.createForumTopic(chatId, topicName, {
                icon_color: iconColor
            });

            await this.saveChatMapping(chatJid, topic.message_thread_id);
            logger.info(`🆕 Created Telegram topic: ${topicName} (ID: ${topic.message_thread_id}) for ${chatJid}`);
            
            if (!isStatus && !isCall) {
                await this.sendWelcomeMessage(topic.message_thread_id, chatJid, isGroup, whatsappMsg);
            }
            
            return topic.message_thread_id;
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

    // FIXED: Profile picture sync
async sendProfilePicture(topicId, jid, isUpdate = false) {
    try {
        if (!config.get('telegram.features.profilePicSync')) return;

        /* debounce WhatsApp duplicate events */
        if (Date.now() - (this._lastPicPush[jid] || 0) < 2000) return;
        this._lastPicPush[jid] = Date.now();

        const profilePicUrl = await this.whatsappBot.sock.profilePictureUrl(jid, 'image');
        if (!profilePicUrl) return;

        /* skip if URL already seen (RAM cache OR DB) */
        const cachedUrl = this.profilePicCache.get(jid);
        const dbUrl     = (this.userMappings.get(jid) || {}).lastProfilePicUrl;
        if (profilePicUrl === cachedUrl || profilePicUrl === dbUrl) return;

        const caption = isUpdate ? '📸 Profile picture updated' : '📸 Profile Picture';
        await this.telegramBot.sendPhoto(config.get('telegram.chatId'), profilePicUrl, {
            message_thread_id: topicId,
            caption
        });

        /* update caches + DB */
        this.profilePicCache.set(jid, profilePicUrl);
        const userData = this.userMappings.get(jid) || {};
        userData.lastProfilePicUrl = profilePicUrl;
        await this.saveUserMapping(jid, userData);

    } catch (err) {
        logger.debug('Could not send profile picture:', err);
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
        }, 30000);

        try {
            const phone = callerId.split('@')[0];
            const callerName = this.contactMappings.get(phone) || `+${phone}`;
            
            const topicId = await this.getOrCreateTopic('call@broadcast', {
                key: { remoteJid: 'call@broadcast', participant: callerId }
            });

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
        let caption = this.extractText(whatsappMsg);
        
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
            return;
        }

        logger.info(`📥 Downloading ${mediaType} from WhatsApp: ${fileName}`);

        const downloadType = mediaType === 'sticker' ? 'sticker' : 
                            mediaType === 'video_note' ? 'video' : 
                            mediaType;
        
        const stream = await downloadContentFromMessage(mediaMessage, downloadType);
        
        if (!stream) {
            logger.error(`❌ Failed to get stream for ${mediaType}`);
            return;
        }
        
        const buffer = await this.streamToBuffer(stream);
        
        if (!buffer || buffer.length === 0) {
            logger.error(`❌ Empty buffer for ${mediaType}`);
            return;
        }
        
        const filePath = path.join(this.tempDir, fileName);
        await fs.writeFile(filePath, buffer);

        logger.info(`💾 Saved ${mediaType} to: ${filePath} (${buffer.length} bytes)`);

        const sender = whatsappMsg.key.remoteJid;
        const participant = whatsappMsg.key.participant || sender;
        
        if (isOutgoing) {
            caption = caption ? `📤 You: ${caption}` : '📤 You sent media';
        } else if (sender.endsWith('@g.us') && participant !== sender) {
            const senderPhone = participant.split('@')[0];
            const senderName = this.contactMappings.get(senderPhone) || senderPhone;
            caption = `👤 ${senderName}:\n${caption || ''}`;
        }

        const chatId = config.get('telegram.chatId');
        const ctx = whatsappMsg.message?.extendedTextMessage?.contextInfo;
        const tgOpt = { message_thread_id: topicId };
        if (ctx?.stanzaId && this.waToTg.has(ctx.stanzaId)) {
            tgOpt.reply_to_message_id = this.waToTg.get(ctx.stanzaId);
        }

        let sentMsg;

        switch (mediaType) {
            case 'image':
                sentMsg = await this.telegramBot.sendPhoto(chatId, filePath, { ...tgOpt, caption });
                break;
                
            case 'video':
                if (mediaMessage.gifPlayback) {
                    sentMsg = await this.telegramBot.sendAnimation(chatId, filePath, { ...tgOpt, caption });
                } else {
                    sentMsg = await this.telegramBot.sendVideo(chatId, filePath, { ...tgOpt, caption });
                }
                break;

            case 'video_note':
                const videoNotePath = await this.convertToVideoNote(filePath);
                sentMsg = await this.telegramBot.sendVideoNote(chatId, videoNotePath, tgOpt);
                if (caption) {
                    await this.telegramBot.sendMessage(chatId, caption, {
                        ...tgOpt,
                        reply_to_message_id: sentMsg?.message_id
                    });
                }
                if (videoNotePath !== filePath) {
                    await fs.unlink(videoNotePath).catch(() => {});
                }
                break;
                
            case 'audio':
                if (mediaMessage.ptt) {
                    sentMsg = await this.telegramBot.sendVoice(chatId, filePath, { ...tgOpt, caption });
                } else {
                    sentMsg = await this.telegramBot.sendAudio(chatId, filePath, {
                        ...tgOpt,
                        caption,
                        title: mediaMessage.title || 'Audio'
                    });
                }
                break;
                
            case 'document':
                sentMsg = await this.telegramBot.sendDocument(chatId, filePath, { ...tgOpt, caption });
                break;
                
            case 'sticker':
                try {
                    sentMsg = await this.telegramBot.sendSticker(chatId, filePath, tgOpt);
                } catch (stickerError) {
                    logger.debug('Failed to send as sticker, converting to PNG:', stickerError);
                    const pngPath = filePath.replace('.webp', '.png');
                    await sharp(filePath).png().toFile(pngPath);
                    
                    sentMsg = await this.telegramBot.sendPhoto(chatId, pngPath, { ...tgOpt, caption: caption || 'Sticker' });
                    await fs.unlink(pngPath).catch(() => {});
                }
                break;
        }

        if (sentMsg) {
            this.tgToWa.set(sentMsg.message_id, whatsappMsg.key);
            this.waToTg.set(whatsappMsg.key.id, sentMsg.message_id);
        }

        logger.info(`✅ Successfully sent ${mediaType} to Telegram`);
        await fs.unlink(filePath).catch(() => {});
        
    } catch (error) {
        logger.error(`❌ Failed to handle WhatsApp ${mediaType}:`, error);
    }
}


    async convertToVideoNote(inputPath) {
        return new Promise((resolve, reject) => {
            const outputPath = inputPath.replace('.mp4', '_note.mp4');
            
            ffmpeg(inputPath)
                .videoFilter('scale=240:240:force_original_aspect_ratio=increase,crop=240:240')
                .duration(60) // Limit to 60 seconds for video notes
                .format('mp4')
                .on('end', () => {
                    logger.debug('Video note conversion completed');
                    resolve(outputPath);
                })
                .on('error', (err) => {
                    logger.debug('Video note conversion failed:', err);
                    resolve(inputPath); // Return original if conversion fails
                })
                .save(outputPath);
        });
    }

    async handleWhatsAppLocation(whatsappMsg, topicId, isOutgoing = false) {
        try {
            const locationMessage = whatsappMsg.message.locationMessage;
            
            const sender = whatsappMsg.key.remoteJid;
            const participant = whatsappMsg.key.participant || sender;
            let caption = '';
            
            if (isOutgoing) {
                caption = '📤 You shared location';
            } else if (sender.endsWith('@g.us') && participant !== sender) {
                const senderPhone = participant.split('@')[0];
                const senderName = this.contactMappings.get(senderPhone) || senderPhone;
                caption = `👤 ${senderName} shared location`;
            }
            
            await this.telegramBot.sendLocation(config.get('telegram.chatId'), 
                locationMessage.degreesLatitude, 
                locationMessage.degreesLongitude, {
                    message_thread_id: topicId
                });
                
            if (caption) {
                await this.telegramBot.sendMessage(config.get('telegram.chatId'), caption, {
                    message_thread_id: topicId
                });
            }
        } catch (error) {
            logger.error('❌ Failed to handle WhatsApp location message:', error);
        }
    }

    async handleWhatsAppContact(whatsappMsg, topicId, isOutgoing = false) {
        try {
            const contactMessage = whatsappMsg.message.contactMessage;
            const displayName = contactMessage.displayName || 'Unknown Contact';

            const sender = whatsappMsg.key.remoteJid;
            const participant = whatsappMsg.key.participant || sender;
            let caption = `📇 Contact: ${displayName}`;
            
            if (isOutgoing) {
                caption = `📤 You shared contact: ${displayName}`;
            } else if (sender.endsWith('@g.us') && participant !== sender) {
                const senderPhone = participant.split('@')[0];
                const senderName = this.contactMappings.get(senderPhone) || senderPhone;
                caption = `👤 ${senderName} shared contact: ${displayName}`;
            }

            const phoneNumber = contactMessage.vcard.match(/TEL.*:(.*)/)?.[1] || '';
            await this.telegramBot.sendContact(config.get('telegram.chatId'), phoneNumber, displayName, {
                message_thread_id: topicId
            });

        } catch (error) {
            logger.error('❌ Failed to handle WhatsApp contact message:', error);
        }
    }

    async markAsRead(jid, messageKeys) {
        try {
            if (!this.whatsappBot?.sock || !messageKeys.length || !config.get('telegram.features.readReceipts')) return;
            
            await this.whatsappBot.sock.readMessages(messageKeys);
            logger.debug(`📖 Marked ${messageKeys.length} messages as read in ${jid}`);
        } catch (error) {
            logger.debug('Failed to mark messages as read:', error);
        }
    }

async handleTelegramMessage(msg) {
    try {
        const topicId     = msg.message_thread_id;
        const whatsappJid = this.findWhatsAppJidByTopic(topicId);
        if (!whatsappJid) {
            logger.warn('⚠️ Could not find WhatsApp chat for Telegram message');
            return;
        }

        await this.sendTypingPresence(whatsappJid);

        /* status replies */
        if (whatsappJid === 'status@broadcast' && msg.reply_to_message) {
            await this.handleStatusReply(msg);
            return;
        }

        /* WA key to quote (if TG user replied) */
        const quoted = msg.reply_to_message
            ? this.tgToWa.get(msg.reply_to_message.message_id)
            : null;

        /* TEXT */
        if (msg.text) {
            const content = { text: msg.text };
            if (msg.entities?.some(e => e.type === 'spoiler')) {
                content.text = `🫥 ${msg.text}`;
            }

            const res = await this.whatsappBot.sendMessage(
                whatsappJid,
                content,
                quoted ? { quoted } : {}
            );

            if (res?.key?.id) {
                this.tgToWa.set(msg.message_id, res.key);
                this.waToTg.set(res.key.id, msg.message_id);
                await this.setReaction(msg.chat.id, msg.message_id, '👍');
                setTimeout(() => this.markAsRead(whatsappJid, [res.key]), 1000);
            }
            return;
        }

        /* MEDIA / OTHER */
        msg.__waQuoted = quoted;               // pass hint to media handler
        if (msg.photo)      return this.handleTelegramMedia(msg,'photo');
        if (msg.video)      return this.handleTelegramMedia(msg,'video');
        if (msg.animation)  return this.handleTelegramMedia(msg,'animation');
        if (msg.video_note) return this.handleTelegramMedia(msg,'video_note');
        if (msg.voice)      return this.handleTelegramMedia(msg,'voice');
        if (msg.audio)      return this.handleTelegramMedia(msg,'audio');
        if (msg.document)   return this.handleTelegramMedia(msg,'document');
        if (msg.sticker)    return this.handleTelegramMedia(msg,'sticker');
        if (msg.location)   return this.handleTelegramLocation(msg);
        if (msg.contact)    return this.handleTelegramContact(msg);

    } catch (err) {
        logger.error('❌ Failed to handle Telegram message:', err);
        await this.setReaction(msg.chat.id, msg.message_id, '❌');
    } finally {
        if (whatsappJid) setTimeout(() => this.sendPresence(whatsappJid,'available'), 2000);
    }
}

    // FIXED: Status reply handling
async handleStatusReply(msg) {
    try {
        const originalStatusKey = this.statusMessageMapping.get(msg.reply_to_message.message_id);
        if (!originalStatusKey) {
            await this.telegramBot.sendMessage(msg.chat.id, '❌ Cannot find original status to reply to', {
                message_thread_id: msg.message_thread_id
            });
            return;
        }

   const statusJid = originalStatusKey.participant;
await this.whatsappBot.sendMessage(
    'status@broadcast',
    { text: msg.text },
    { statusJidList: [statusJid], quoted: originalStatusKey } // 👈
);

        await this.setReaction(msg.chat.id, msg.message_id, '✅');
    } catch (err) {
        logger.error('❌ Failed to handle status reply:', err);
        await this.setReaction(msg.chat.id, msg.message_id, '❌');
    }
}

async handleTelegramMedia(msg, mediaType) {
    try {
        const topicId = msg.message_thread_id;
        const whatsappJid = this.findWhatsAppJidByTopic(topicId);
        
        if (!whatsappJid) {
            logger.warn('⚠️ Could not find WhatsApp chat for Telegram media');
            return;
        }

        await this.sendPresence(whatsappJid, false);

        let fileId, fileName, caption = msg.caption || '';

        switch (mediaType) {
            case 'photo':
                fileId = msg.photo[msg.photo.length - 1].file_id;
                fileName = `photo_${Date.now()}.jpg`;
                break;
            case 'video':
                fileId = msg.video.file_id;
                fileName = `video_${Date.now()}.mp4`;
                break;
            case 'animation':
                fileId = msg.animation.file_id;
                fileName = `animation_${Date.now()}.mp4`;
                break;
            case 'video_note':
                fileId = msg.video_note.file_id;
                fileName = `video_note_${Date.now()}.mp4`;
                break;
            case 'voice':
                fileId = msg.voice.file_id;
                fileName = `voice_${Date.now()}.ogg`;
                break;
            case 'audio':
                fileId = msg.audio.file_id;
                fileName = msg.audio.file_name || `audio_${Date.now()}.mp3`;
                break;
            case 'document':
                fileId = msg.document.file_id;
                fileName = msg.document.file_name || `document_${Date.now()}`;
                break;
            case 'sticker':
                fileId = msg.sticker.file_id;
                fileName = `sticker_${Date.now()}.webp`;
                break;
        }

        logger.info(`📥 Downloading ${mediaType} from Telegram: ${fileName}`);

        const fileLink = await this.telegramBot.getFileLink(fileId);
        const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data);
        
        const filePath = path.join(this.tempDir, fileName);
        await fs.writeFile(filePath, buffer);

        logger.info(`💾 Saved ${mediaType} to: ${filePath} (${buffer.length} bytes)`);

        let messageOptions = {};

        const hasMediaSpoiler = msg.has_media_spoiler || 
            (msg.caption_entities && msg.caption_entities.some(entity => entity.type === 'spoiler'));

        switch (mediaType) {
            case 'photo':
                messageOptions = {
                    image: fs.readFileSync(filePath),
                    caption: caption,
                    viewOnce: hasMediaSpoiler
                };
                break;
                
            case 'video':
                messageOptions = {
                    video: fs.readFileSync(filePath),
                    caption: caption,
                    viewOnce: hasMediaSpoiler
                };
                break;

            case 'video_note':
                messageOptions = {
                    video: fs.readFileSync(filePath),
                    caption: caption,
                    ptv: true,
                    viewOnce: hasMediaSpoiler
                };
                break;

            case 'animation':
                messageOptions = {
                    video: fs.readFileSync(filePath),
                    caption: caption,
                    gifPlayback: true,
                    viewOnce: hasMediaSpoiler
                };
                break;
                
            case 'voice':
                messageOptions = {
                    audio: fs.readFileSync(filePath),
                    ptt: true,
                    mimetype: 'audio/ogg; codecs=opus'
                };
                break;
                
            case 'audio':
                messageOptions = {
                    audio: fs.readFileSync(filePath),
                    mimetype: mime.lookup(fileName) || 'audio/mp3',
                    fileName: fileName,
                    caption: caption
                };
                break;
                
            case 'document':
                messageOptions = {
                    document: fs.readFileSync(filePath),
                    fileName: fileName,
                    mimetype: mime.lookup(fileName) || 'application/octet-stream',
                    caption: caption
                };
                break;
                
            case 'sticker':
                await this.handleTelegramSticker(msg);
                return;
        }

        // QUOTING support
        const quoted = msg.__waQuoted || (
            msg.reply_to_message ? this.tgToWa.get(msg.reply_to_message.message_id) : null
        );

        // Send to WhatsApp with quoting (if applicable)
        const sendResult = await this.whatsappBot.sendMessage(
            whatsappJid,
            messageOptions,
            quoted ? { quoted } : {}
        );

        await fs.unlink(filePath).catch(() => {});

        if (sendResult?.key?.id) {
            logger.info(`✅ Successfully sent ${mediaType} to WhatsApp`);
            this.tgToWa.set(msg.message_id, sendResult.key);
            this.waToTg.set(sendResult.key.id, msg.message_id);
            await this.setReaction(msg.chat.id, msg.message_id, '👍');
            setTimeout(() => this.markAsRead(whatsappJid, [sendResult.key]), 1000);
        } else {
            logger.warn(`⚠️ Failed to send ${mediaType} to WhatsApp - no message ID`);
            await this.setReaction(msg.chat.id, msg.message_id, '❌');
        }

    } catch (error) {
        logger.error(`❌ Failed to handle Telegram ${mediaType}:`, error);
        await this.setReaction(msg.chat.id, msg.message_id, '❌');
    }
}

    async handleTelegramSticker(msg) {
        const topicId = msg.message_thread_id;
        const whatsappJid = this.findWhatsAppJidByTopic(topicId);
        const chatId = msg.chat.id;

        if (!whatsappJid) {
            logger.warn('⚠️ Could not find WhatsApp chat for Telegram sticker');
            return;
        }

        try {
            await this.sendPresence(whatsappJid, 'composing');

            const fileId = msg.sticker.file_id;
            const fileLink = await this.telegramBot.getFileLink(fileId);
            const stickerBuffer = (await axios.get(fileLink, { responseType: 'arraybuffer' })).data;
            const fileName = `sticker_${Date.now()}`;
            const inputPath = path.join(this.tempDir, `${fileName}.webp`);
            await fs.writeFile(inputPath, stickerBuffer);

            let outputBuffer;

            // Detect animated sticker type
            const isAnimated = msg.sticker.is_animated || msg.sticker.is_video;

            if (isAnimated) {
                const animatedPath = await this.convertAnimatedSticker(inputPath);
                if (animatedPath) {
                    outputBuffer = await fs.readFile(animatedPath);
                    await fs.unlink(animatedPath).catch(() => {});
                } else {
                    throw new Error('Animated sticker conversion failed');
                }
            } else {
                const sticker = new Sticker(stickerBuffer, {
                    type: StickerTypes.FULL,
                    pack: 'Telegram Stickers',
                    author: 'BridgeBot',
                    quality: 100
                });
                outputBuffer = await sticker.toBuffer();
            }

            const result = await this.whatsappBot.sendMessage(whatsappJid, {
                sticker: outputBuffer
            });

            await fs.unlink(inputPath).catch(() => {});

            if (result?.key?.id) {
                logger.info('✅ Sticker sent to WhatsApp');
                await this.setReaction(chatId, msg.message_id, '👍');
            } else {
                throw new Error('Sticker sent but no confirmation');
            }
        } catch (err) {
            logger.error('❌ Failed to send sticker to WhatsApp:', err);
            await this.setReaction(chatId, msg.message_id, '❌');

            // Fallback: send as photo
            const fallbackPath = path.join(this.tempDir, `fallback_${Date.now()}.png`);
            await sharp(stickerBuffer).resize(512, 512).png().toFile(fallbackPath);
            await this.telegramBot.sendPhoto(chatId, fallbackPath, {
                message_thread_id: topicId,
                caption: 'Sticker (fallback)'
            });
            await fs.unlink(fallbackPath).catch(() => {});
        }
    }

    async convertAnimatedSticker(inputPath) {
        const outputPath = inputPath.replace('.webp', '-converted.webp');

        return new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .outputOptions([
                    '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
                    '-loop', '0',
                    '-an',
                    '-vsync', '0'
                ])
                .outputFormat('webp')
                .on('end', () => resolve(outputPath))
                .on('error', (err) => {
                    logger.debug('Animated sticker conversion failed:', err.message);
                    resolve(null); // fallback
                })
                .save(outputPath);
        });
    }

    async handleTelegramLocation(msg) {
        try {
            const topicId = msg.message_thread_id;
            const whatsappJid = this.findWhatsAppJidByTopic(topicId);

            if (!whatsappJid) {
                logger.warn('⚠️ Could not find WhatsApp chat for Telegram location');
                return;
            }

            await this.sendPresence(whatsappJid, 'available');

            const sendResult = await this.whatsappBot.sendMessage(whatsappJid, { 
                location: { 
                    degreesLatitude: msg.location.latitude, 
                    degreesLongitude: msg.location.longitude
                } 
            });

            if (sendResult?.key?.id) {
                await this.setReaction(msg.chat.id, msg.message_id, '👍');
                setTimeout(async () => {
                    await this.markAsRead(whatsappJid, [sendResult.key]);
                }, 1000);
            }
        } catch (error) {
            logger.error('❌ Failed to handle Telegram location message:', error);
            await this.setReaction(msg.chat.id, msg.message_id, '❌');
        }
    }

    async handleTelegramContact(msg) {
        try {
            const topicId = msg.message_thread_id;
            const whatsappJid = this.findWhatsAppJidByTopic(topicId);

            if (!whatsappJid) {
                logger.warn('⚠️ Could not find WhatsApp chat for Telegram contact');
                return;
            }

            await this.sendPresence(whatsappJid, 'available');

            const firstName = msg.contact.first_name || '';
            const lastName = msg.contact.last_name || '';
            const phoneNumber = msg.contact.phone_number || '';
            const displayName = `${firstName} ${lastName}`.trim() || phoneNumber;

            const vcard = `BEGIN:VCARD\nVERSION:3.0\nN:${lastName};${firstName};;;\nFN:${displayName}\nTEL;TYPE=CELL:${phoneNumber}\nEND:VCARD`;

            const sendResult = await this.whatsappBot.sendMessage(whatsappJid, { 
                contacts: { 
                    displayName: displayName, 
                    contacts: [{ vcard: vcard }]
                } 
            });

            if (sendResult?.key?.id) {
                await this.setReaction(msg.chat.id, msg.message_id, '👍');
                setTimeout(async () => {
                    await this.markAsRead(whatsappJid, [sendResult.key]);
                }, 1000);
            }
        } catch (error) {
            logger.error('❌ Failed to handle Telegram contact message:', error);
            await this.setReaction(msg.chat.id, msg.message_id, '❌');
        }
    }

// ───────────────────────────────────────────────────────────
// helper for plain text WA → TG (keeps quotes)
// ───────────────────────────────────────────────────────────
async sendSimpleMessage(topicId, text, whatsappMsg) {
    if (!topicId) return null;
    const chatId = config.get('telegram.chatId');

    /* reply‑to if WA was itself a reply */
    const ctx   = whatsappMsg?.message?.extendedTextMessage?.contextInfo;
    const tgOpt = { message_thread_id: topicId };
    if (ctx?.stanzaId && this.waToTg.has(ctx.stanzaId)) {
        tgOpt.reply_to_message_id = this.waToTg.get(ctx.stanzaId);
    }

    try {
        const sent = await this.telegramBot.sendMessage(chatId, text, tgOpt);
        if (sent && whatsappMsg) {
            this.tgToWa.set(sent.message_id, whatsappMsg.key);
            this.waToTg.set(whatsappMsg.key.id, sent.message_id);
        }
        return sent?.message_id || null;
    } catch (err) {
        logger.error('❌ Failed to send TG text:', err);
        return null;
    }
}


    async streamToBuffer(stream) {
        const chunks = [];
        for await (const chunk of stream) {
            chunks.push(chunk);
        }
        return Buffer.concat(chunks);
    }

    findWhatsAppJidByTopic(topicId) {
        for (const [jid, topic] of this.chatMappings.entries()) {
            if (topic === topicId) {
                return jid;
            }
        }
        return null;
    }

    extractText(msg) {
        return msg.message?.conversation ||
               msg.message?.extendedTextMessage?.text ||
               msg.message?.imageMessage?.caption ||
               msg.message?.videoMessage?.caption ||
               msg.message?.documentMessage?.caption ||
               msg.message?.audioMessage?.caption ||
               '';
    }

    async syncWhatsAppConnection() {
        if (!this.telegramBot) return;

        await this.logToTelegram('🤖 HyperWa Bot Connected', 
            `✅ Bot: ${config.get('bot.name')} v${config.get('bot.version')}\n` +
            `📱 WhatsApp: Connected\n` +
            `🔗 Telegram Bridge: Active\n` +
            `📞 Contacts: ${this.contactMappings.size} synced\n` +
            `🚀 Ready to bridge messages!`);

        // FIXED: Sync contacts on reconnect
        await this.syncContacts();
        
        // FIXED: Recreate missing topics
        await this.recreateMissingTopics();
    }

    async setupWhatsAppHandlers() {
        if (!this.whatsappBot?.sock) {
            logger.warn('⚠️ WhatsApp socket not available for setting up handlers');
            return;
        }

        // FIXED: Enhanced contact sync handlers
        this.whatsappBot.sock.ev.on('contacts.update', async (contacts) => {
            try {
                let updatedCount = 0;
                for (const contact of contacts) {
                    if (contact.id && contact.name) {
                        const phone = contact.id.split('@')[0];
                        const oldName = this.contactMappings.get(phone);
                        
                        // Only update if it's a real contact name (not handle name)
                        if (contact.name !== phone && 
                            !contact.name.startsWith('+') && 
                            contact.name.length > 2 &&
                            oldName !== contact.name) {
                            await this.saveContactMapping(phone, contact.name);
                            logger.info(`📞 Updated contact: ${phone} -> ${contact.name}`);
                            updatedCount++;
                            
                            // Update topic name immediately
                            const jid = contact.id;
                            if (this.chatMappings.has(jid)) {
                                const topicId = this.chatMappings.get(jid);
                                try {
                                    await this.telegramBot.editForumTopic(config.get('telegram.chatId'), topicId, {
                                        name: contact.name
                                    });
                                    logger.info(`📝 Updated topic name for ${phone} to ${contact.name}`);
                                } catch (error) {
                                    logger.debug(`Could not update topic name for ${phone}:`, error);
                                }
                            }
                        }
                    }
                }
                if (updatedCount > 0) {
                    logger.info(`✅ Processed ${updatedCount} contact updates`);
                }
            } catch (error) {
                logger.error('❌ Failed to process contact updates:', error);
            }
        });

        this.whatsappBot.sock.ev.on('contacts.upsert', async (contacts) => {
            try {
                let newCount = 0;
                for (const contact of contacts) {
                    if (contact.id && contact.name) {
                        const phone = contact.id.split('@')[0];
                        // Only save real contact names
                        if (contact.name !== phone && 
                            !contact.name.startsWith('+') && 
                            contact.name.length > 2 &&
                            !this.contactMappings.has(phone)) {
                            await this.saveContactMapping(phone, contact.name);
                            logger.info(`📞 New contact: ${phone} -> ${contact.name}`);
                            newCount++;
                        }
                    }
                }
                if (newCount > 0) {
                    logger.info(`✅ Added ${newCount} new contacts`);
                }
            } catch (error) {
                logger.error('❌ Failed to process new contacts:', error);
            }
        });

        // FIXED: Profile picture update handler
        this.whatsappBot.sock.ev.on('contacts.update', async (contacts) => {
            for (const contact of contacts) {
                if (contact.id && this.chatMappings.has(contact.id)) {
                    const topicId = this.chatMappings.get(contact.id);
                    
                    try {
                        const newProfilePicUrl = await this.whatsappBot.sock.profilePictureUrl(contact.id, 'image');
                        const oldProfilePicUrl = this.profilePicCache.get(contact.id);
                        
                        if (newProfilePicUrl && newProfilePicUrl !== oldProfilePicUrl) {
                            await this.sendProfilePicture(topicId, contact.id, true);
                            logger.info(`📸 Profile picture updated for ${contact.id}`);
                        }
                    } catch (error) {
                        logger.debug(`Could not check profile picture for ${contact.id}:`, error);
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
