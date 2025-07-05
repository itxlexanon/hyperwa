const TelegramBot = require('node-telegram-bot-api');
const qrcode = require('qrcode');
const fs = require('fs-extra');
const path = require('path');
const logger = require('../Core/logger');
const config = require('../config');
const { connectDb } = require('../utils/db');
const TelegramCommands = require('./commands');

class TelegramBridge {
    constructor(whatsappBot) {
        this.whatsappBot = whatsappBot;
        this.telegramBot = null;
        this.commands = null;
        this.db = null;
        this.collection = null;
        
        // Mappings
        this.chatMappings = new Map(); // WhatsApp JID -> Telegram Topic ID
        this.userMappings = new Map(); // WhatsApp JID -> User Info
        this.contactMappings = new Map(); // Phone -> Name
        this.statusMappings = new Map(); // Status ID -> Topic ID
        this.topicMappings = new Map(); // Topic ID -> WhatsApp JID
        
        // Configuration
        this.config = {
            botToken: config.get('telegram.botToken'),
            chatId: config.get('telegram.chatId'),
            adminIds: config.get('telegram.adminIds') || [],
            features: config.get('telegram.features') || {}
        };
        
        this.isInitialized = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
    }

    async initialize() {
        try {
            logger.info('🔧 Initializing Telegram Bridge...');
            
            // Connect to database
            this.db = await connectDb();
            this.collection = this.db.collection('telegram_bridge');
            
            // Initialize Telegram bot
            if (!this.config.botToken) {
                logger.warn('⚠️ Telegram bot token not configured');
                return;
            }
            
            this.telegramBot = new TelegramBot(this.config.botToken, { polling: true });
            this.commands = new TelegramCommands(this);
            
            // Setup event handlers
            this.setupTelegramHandlers();
            
            // Load existing mappings
            await this.loadMappingsFromDb();
            
            // Register bot commands
            await this.commands.registerBotCommands();
            
            this.isInitialized = true;
            logger.info('✅ Telegram Bridge initialized successfully');
            
        } catch (error) {
            logger.error('❌ Failed to initialize Telegram Bridge:', error);
            throw error;
        }
    }

    setupTelegramHandlers() {
        // Handle incoming messages
        this.telegramBot.on('message', async (msg) => {
            try {
                if (msg.text && msg.text.startsWith('/')) {
                    await this.commands.handleCommand(msg);
                } else {
                    await this.handleTelegramMessage(msg);
                }
            } catch (error) {
                logger.error('❌ Error handling Telegram message:', error);
            }
        });

        // Handle callback queries
        this.telegramBot.on('callback_query', async (query) => {
            try {
                await this.handleCallbackQuery(query);
            } catch (error) {
                logger.error('❌ Error handling callback query:', error);
            }
        });

        // Handle errors
        this.telegramBot.on('error', (error) => {
            logger.error('❌ Telegram Bot error:', error);
        });

        // Handle polling errors
        this.telegramBot.on('polling_error', (error) => {
            logger.error('❌ Telegram polling error:', error);
        });
    }

    async setupWhatsAppHandlers() {
        if (!this.whatsappBot?.sock) return;

        // Handle status updates
        this.whatsappBot.sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            
            for (const msg of messages) {
                if (msg.key.remoteJid === 'status@broadcast') {
                    await this.handleStatusMessage(msg);
                }
            }
        });

        // Handle connection updates
        this.whatsappBot.sock.ev.on('connection.update', async (update) => {
            if (update.connection === 'open') {
                await this.onWhatsAppReconnect();
            }
        });
    }

    async handleStatusMessage(msg) {
        try {
            if (!this.config.features.statusSync) return;

            const participant = msg.key.participant;
            const statusId = msg.key.id;
            
            // Get contact info
            const phone = participant.split('@')[0];
            const contactName = this.contactMappings.get(phone) || phone;
            
            // Extract status content
            const text = this.extractText(msg);
            const mediaType = this.getMediaType(msg);
            
            // Create or get status topic
            const topicId = await this.getOrCreateStatusTopic(participant, contactName, phone);
            
            if (!topicId) {
                logger.warn(`⚠️ Failed to create status topic for ${contactName}`);
                return;
            }

            // Store status mapping
            this.statusMappings.set(statusId, topicId);
            
            // Prepare status message
            let statusText = `📱 *Status from ${contactName}*\n`;
            statusText += `📞 Phone: +${phone}\n`;
            statusText += `⏰ Time: ${new Date().toLocaleString()}\n\n`;
            
            if (text) {
                statusText += `💬 *Message:*\n${text}`;
            }
            
            // Send status to Telegram
            if (mediaType && mediaType !== 'text') {
                await this.forwardStatusMedia(msg, topicId, statusText, mediaType);
            } else {
                await this.telegramBot.sendMessage(this.config.chatId, statusText, {
                    message_thread_id: topicId,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '❤️ Like', callback_data: `like_status_${statusId}` },
                            { text: '💬 Reply', callback_data: `reply_status_${statusId}` }
                        ]]
                    }
                });
            }

            // Auto-view status if enabled
            if (config.get('features.autoViewStatus')) {
                await this.whatsappBot.sock.readMessages([msg.key]);
            }

            logger.info(`📱 Status synced from ${contactName} to topic ${topicId}`);
            
        } catch (error) {
            logger.error('❌ Error handling status message:', error);
        }
    }

    async getOrCreateStatusTopic(participant, contactName, phone) {
        try {
            // Check if topic already exists
            const existingTopicId = this.chatMappings.get(participant);
            if (existingTopicId) {
                // Verify topic still exists
                if (await this.verifyTopicExists(existingTopicId)) {
                    return existingTopicId;
                } else {
                    // Topic was deleted, remove from mappings
                    this.chatMappings.delete(participant);
                    this.topicMappings.delete(existingTopicId);
                }
            }

            // Create new topic for status
            const topicName = `📱 ${contactName} (+${phone})`;
            const topic = await this.telegramBot.createForumTopic(this.config.chatId, topicName, {
                icon_custom_emoji_id: '📱' // Status emoji
            });

            if (topic && topic.message_thread_id) {
                const topicId = topic.message_thread_id;
                
                // Store mappings
                this.chatMappings.set(participant, topicId);
                this.topicMappings.set(topicId, participant);
                
                // Save to database
                await this.saveMappingsToDb();
                
                // Send welcome message to topic
                const welcomeMsg = `📱 *Status Topic Created*\n\n` +
                    `👤 Contact: ${contactName}\n` +
                    `📞 Phone: +${phone}\n` +
                    `🔗 WhatsApp ID: ${participant}\n\n` +
                    `💡 *How to use:*\n` +
                    `• View status updates here\n` +
                    `• Reply to status by replying to messages\n` +
                    `• Like status using buttons`;

                await this.telegramBot.sendMessage(this.config.chatId, welcomeMsg, {
                    message_thread_id: topicId,
                    parse_mode: 'Markdown'
                });

                logger.info(`✅ Created status topic for ${contactName}: ${topicId}`);
                return topicId;
            }
            
        } catch (error) {
            logger.error(`❌ Error creating status topic for ${contactName}:`, error);
            return null;
        }
    }

    async forwardStatusMedia(msg, topicId, caption, mediaType) {
        try {
            const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
            
            let stream, filename, options = {
                message_thread_id: topicId,
                caption: caption,
                parse_mode: 'Markdown'
            };

            switch (mediaType) {
                case 'image':
                    stream = await downloadContentFromMessage(msg.message.imageMessage, 'image');
                    filename = 'status_image.jpg';
                    break;
                case 'video':
                    stream = await downloadContentFromMessage(msg.message.videoMessage, 'video');
                    filename = 'status_video.mp4';
                    break;
                case 'audio':
                    stream = await downloadContentFromMessage(msg.message.audioMessage, 'audio');
                    filename = 'status_audio.mp3';
                    break;
                default:
                    // Fallback to text
                    await this.telegramBot.sendMessage(this.config.chatId, caption, {
                        message_thread_id: topicId,
                        parse_mode: 'Markdown'
                    });
                    return;
            }

            // Download media
            const chunks = [];
            for await (const chunk of stream) {
                chunks.push(chunk);
            }
            const buffer = Buffer.concat(chunks);

            // Send media based on type
            switch (mediaType) {
                case 'image':
                    await this.telegramBot.sendPhoto(this.config.chatId, buffer, options);
                    break;
                case 'video':
                    await this.telegramBot.sendVideo(this.config.chatId, buffer, options);
                    break;
                case 'audio':
                    await this.telegramBot.sendAudio(this.config.chatId, buffer, options);
                    break;
            }

        } catch (error) {
            logger.error('❌ Error forwarding status media:', error);
            // Fallback to text message
            await this.telegramBot.sendMessage(this.config.chatId, caption, {
                message_thread_id: topicId,
                parse_mode: 'Markdown'
            });
        }
    }

    async handleCallbackQuery(query) {
        try {
            const data = query.data;
            const messageId = query.message.message_id;
            const chatId = query.message.chat.id;

            if (data.startsWith('like_status_')) {
                const statusId = data.replace('like_status_', '');
                await this.likeStatus(statusId, query.from);
                await this.telegramBot.answerCallbackQuery(query.id, { text: '❤️ Status liked!' });
                
            } else if (data.startsWith('reply_status_')) {
                const statusId = data.replace('reply_status_', '');
                await this.telegramBot.answerCallbackQuery(query.id, { 
                    text: '💬 Reply to this message to send a status reply' 
                });
            }
            
        } catch (error) {
            logger.error('❌ Error handling callback query:', error);
            await this.telegramBot.answerCallbackQuery(query.id, { text: '❌ Error occurred' });
        }
    }

    async likeStatus(statusId, user) {
        try {
            // Find the original status message
            const statusKey = { id: statusId, remoteJid: 'status@broadcast' };
            
            // Send reaction to WhatsApp status
            await this.whatsappBot.sock.sendMessage('status@broadcast', {
                react: { key: statusKey, text: '❤️' }
            });

            logger.info(`❤️ Status ${statusId} liked by ${user.first_name}`);
            
        } catch (error) {
            logger.error('❌ Error liking status:', error);
        }
    }

    async handleTelegramMessage(msg) {
        try {
            // Check if message is in a topic
            const topicId = msg.message_thread_id;
            if (!topicId) return;

            // Get WhatsApp JID from topic mapping
            const whatsappJid = this.topicMappings.get(topicId);
            if (!whatsappJid) return;

            // Handle status replies
            if (whatsappJid.includes('@s.whatsapp.net') && msg.reply_to_message) {
                await this.handleStatusReply(msg, whatsappJid);
                return;
            }

            // Handle regular chat messages
            await this.forwardToWhatsApp(msg, whatsappJid);
            
        } catch (error) {
            logger.error('❌ Error handling Telegram message:', error);
        }
    }

    async handleStatusReply(msg, participant) {
        try {
            const replyText = msg.text || msg.caption || '';
            if (!replyText) return;

            // Send status reply to WhatsApp
            await this.whatsappBot.sock.sendMessage('status@broadcast', {
                text: replyText
            }, {
                statusJidList: [participant]
            });

            // Confirm in Telegram
            await this.telegramBot.sendMessage(msg.chat.id, 
                `✅ Status reply sent to ${participant.split('@')[0]}`, {
                message_thread_id: msg.message_thread_id
            });

            logger.info(`💬 Status reply sent to ${participant}`);
            
        } catch (error) {
            logger.error('❌ Error sending status reply:', error);
            await this.telegramBot.sendMessage(msg.chat.id, 
                `❌ Failed to send status reply: ${error.message}`, {
                message_thread_id: msg.message_thread_id
            });
        }
    }

    async forwardToWhatsApp(msg, whatsappJid) {
        try {
            let content = {};

            if (msg.text) {
                content.text = msg.text;
            } else if (msg.photo) {
                const photo = msg.photo[msg.photo.length - 1];
                const file = await this.telegramBot.getFile(photo.file_id);
                const buffer = await this.downloadTelegramFile(file.file_path);
                content.image = buffer;
                if (msg.caption) content.caption = msg.caption;
            } else if (msg.video) {
                const file = await this.telegramBot.getFile(msg.video.file_id);
                const buffer = await this.downloadTelegramFile(file.file_path);
                content.video = buffer;
                if (msg.caption) content.caption = msg.caption;
            } else if (msg.audio || msg.voice) {
                const audio = msg.audio || msg.voice;
                const file = await this.telegramBot.getFile(audio.file_id);
                const buffer = await this.downloadTelegramFile(file.file_path);
                content.audio = buffer;
                content.ptt = !!msg.voice;
            } else if (msg.document) {
                const file = await this.telegramBot.getFile(msg.document.file_id);
                const buffer = await this.downloadTelegramFile(file.file_path);
                content.document = buffer;
                content.fileName = msg.document.file_name;
                if (msg.caption) content.caption = msg.caption;
            }

            if (Object.keys(content).length > 0) {
                await this.whatsappBot.sendMessage(whatsappJid, content);
                logger.info(`📤 Message forwarded to WhatsApp: ${whatsappJid}`);
            }

        } catch (error) {
            logger.error('❌ Error forwarding to WhatsApp:', error);
        }
    }

    async downloadTelegramFile(filePath) {
        const response = await fetch(`https://api.telegram.org/file/bot${this.config.botToken}/${filePath}`);
        return Buffer.from(await response.arrayBuffer());
    }

    async verifyTopicExists(topicId) {
        try {
            // Try to send a test message to verify topic exists
            await this.telegramBot.sendMessage(this.config.chatId, '🔍 Verifying topic...', {
                message_thread_id: topicId
            });
            
            // If successful, delete the test message
            // Note: We can't actually delete it without message_id, but the send will fail if topic doesn't exist
            return true;
            
        } catch (error) {
            // If error contains "thread not found" or similar, topic was deleted
            if (error.message.includes('thread') || error.message.includes('topic')) {
                return false;
            }
            // For other errors, assume topic exists
            return true;
        }
    }

    async onWhatsAppReconnect() {
        try {
            logger.info('🔄 WhatsApp reconnected, recreating missing topics...');
            
            // Get all contacts that should have topics
            const contactsWithTopics = [...this.chatMappings.entries()];
            
            for (const [whatsappJid, topicId] of contactsWithTopics) {
                // Verify topic still exists
                if (!(await this.verifyTopicExists(topicId))) {
                    logger.info(`🔄 Recreating missing topic for ${whatsappJid}`);
                    
                    // Remove old mapping
                    this.chatMappings.delete(whatsappJid);
                    this.topicMappings.delete(topicId);
                    
                    // Get contact info
                    const phone = whatsappJid.split('@')[0];
                    const contactName = this.contactMappings.get(phone) || phone;
                    
                    // Recreate topic
                    await this.getOrCreateStatusTopic(whatsappJid, contactName, phone);
                }
            }
            
            // Save updated mappings
            await this.saveMappingsToDb();
            
            logger.info('✅ Topic recreation completed');
            
        } catch (error) {
            logger.error('❌ Error during WhatsApp reconnect handling:', error);
        }
    }

    async syncMessage(msg, text) {
        try {
            if (!this.isInitialized || !this.config.features.biDirectional) return;

            const sender = msg.key.remoteJid;
            const participant = msg.key.participant || sender;
            
            // Skip status messages (handled separately)
            if (sender === 'status@broadcast') return;
            
            // Skip own messages
            if (msg.key.fromMe) return;

            // Get or create topic for this chat
            const topicId = await this.getOrCreateChatTopic(sender, participant);
            if (!topicId) return;

            // Format message
            let messageText = '';
            const phone = participant.split('@')[0];
            const contactName = this.contactMappings.get(phone) || phone;
            
            if (sender.endsWith('@g.us')) {
                messageText = `👤 *${contactName}*\n`;
            }
            
            if (text) {
                messageText += text;
            }

            // Handle media
            const mediaType = this.getMediaType(msg);
            if (mediaType && mediaType !== 'text') {
                await this.forwardMediaToTelegram(msg, topicId, messageText, mediaType);
            } else if (messageText) {
                await this.telegramBot.sendMessage(this.config.chatId, messageText, {
                    message_thread_id: topicId,
                    parse_mode: 'Markdown'
                });
            }

        } catch (error) {
            logger.error('❌ Error syncing message to Telegram:', error);
        }
    }

    async getOrCreateChatTopic(sender, participant) {
        try {
            // Check existing mapping
            let topicId = this.chatMappings.get(sender);
            if (topicId && await this.verifyTopicExists(topicId)) {
                return topicId;
            }

            // Remove invalid mapping
            if (topicId) {
                this.chatMappings.delete(sender);
                this.topicMappings.delete(topicId);
            }

            // Create new topic
            const phone = participant.split('@')[0];
            const contactName = this.contactMappings.get(phone) || phone;
            const isGroup = sender.endsWith('@g.us');
            
            const topicName = isGroup ? 
                `👥 ${contactName}` : 
                `💬 ${contactName} (+${phone})`;

            const topic = await this.telegramBot.createForumTopic(this.config.chatId, topicName);
            
            if (topic && topic.message_thread_id) {
                topicId = topic.message_thread_id;
                this.chatMappings.set(sender, topicId);
                this.topicMappings.set(topicId, sender);
                await this.saveMappingsToDb();
                return topicId;
            }

        } catch (error) {
            logger.error('❌ Error creating chat topic:', error);
        }
        
        return null;
    }

    async forwardMediaToTelegram(msg, topicId, caption, mediaType) {
        try {
            const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
            
            let stream, options = {
                message_thread_id: topicId,
                caption: caption,
                parse_mode: 'Markdown'
            };

            switch (mediaType) {
                case 'image':
                    stream = await downloadContentFromMessage(msg.message.imageMessage, 'image');
                    break;
                case 'video':
                    stream = await downloadContentFromMessage(msg.message.videoMessage, 'video');
                    break;
                case 'audio':
                    stream = await downloadContentFromMessage(msg.message.audioMessage, 'audio');
                    break;
                case 'document':
                    stream = await downloadContentFromMessage(msg.message.documentMessage, 'document');
                    break;
                default:
                    await this.telegramBot.sendMessage(this.config.chatId, caption, options);
                    return;
            }

            const chunks = [];
            for await (const chunk of stream) {
                chunks.push(chunk);
            }
            const buffer = Buffer.concat(chunks);

            switch (mediaType) {
                case 'image':
                    await this.telegramBot.sendPhoto(this.config.chatId, buffer, options);
                    break;
                case 'video':
                    await this.telegramBot.sendVideo(this.config.chatId, buffer, options);
                    break;
                case 'audio':
                    await this.telegramBot.sendAudio(this.config.chatId, buffer, options);
                    break;
                case 'document':
                    await this.telegramBot.sendDocument(this.config.chatId, buffer, options);
                    break;
            }

        } catch (error) {
            logger.error('❌ Error forwarding media to Telegram:', error);
            await this.telegramBot.sendMessage(this.config.chatId, caption, {
                message_thread_id: topicId,
                parse_mode: 'Markdown'
            });
        }
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

    async sendQRCode(qr) {
        try {
            if (!this.telegramBot || !this.config.chatId) return;

            const qrBuffer = await qrcode.toBuffer(qr, { width: 256 });
            
            await this.telegramBot.sendPhoto(this.config.chatId, qrBuffer, {
                caption: '📱 *WhatsApp QR Code*\n\nScan this QR code with WhatsApp to connect your account.',
                parse_mode: 'Markdown'
            });

        } catch (error) {
            logger.error('❌ Error sending QR code to Telegram:', error);
        }
    }

    async logToTelegram(title, message) {
        try {
            if (!this.telegramBot || !this.config.chatId) return;

            const logMessage = `🤖 *${title}*\n\n${message}\n\n⏰ ${new Date().toLocaleString()}`;
            
            await this.telegramBot.sendMessage(this.config.chatId, logMessage, {
                parse_mode: 'Markdown'
            });

        } catch (error) {
            logger.error('❌ Error logging to Telegram:', error);
        }
    }

    async syncContacts() {
        try {
            if (!this.whatsappBot?.sock?.store) return;

            const contacts = Object.values(this.whatsappBot.sock.store.contacts || {});
            
            for (const contact of contacts) {
                if (contact.id && !contact.id.endsWith('@g.us')) {
                    const phone = contact.id.split('@')[0];
                    const name = contact.name || contact.notify || phone;
                    this.contactMappings.set(phone, name);
                }
            }

            await this.saveMappingsToDb();
            logger.info(`📞 Synced ${this.contactMappings.size} contacts`);

        } catch (error) {
            logger.error('❌ Error syncing contacts:', error);
        }
    }

    async syncWhatsAppConnection() {
        try {
            if (!this.whatsappBot?.sock?.user) return;

            const user = this.whatsappBot.sock.user;
            const connectionMsg = `✅ *WhatsApp Connected*\n\n` +
                `👤 User: ${user.name || 'Unknown'}\n` +
                `📱 Phone: ${user.id.split(':')[0]}\n` +
                `⏰ Connected: ${new Date().toLocaleString()}`;

            await this.logToTelegram('WhatsApp Connection', connectionMsg);

        } catch (error) {
            logger.error('❌ Error syncing WhatsApp connection:', error);
        }
    }

    async loadMappingsFromDb() {
        try {
            const data = await this.collection.findOne({ _id: 'mappings' });
            if (data) {
                this.chatMappings = new Map(data.chatMappings || []);
                this.userMappings = new Map(data.userMappings || []);
                this.contactMappings = new Map(data.contactMappings || []);
                this.statusMappings = new Map(data.statusMappings || []);
                this.topicMappings = new Map(data.topicMappings || []);
                
                logger.info(`📊 Loaded mappings: ${this.chatMappings.size} chats, ${this.contactMappings.size} contacts`);
            }
        } catch (error) {
            logger.error('❌ Error loading mappings from database:', error);
        }
    }

    async saveMappingsToDb() {
        try {
            await this.collection.updateOne(
                { _id: 'mappings' },
                {
                    $set: {
                        chatMappings: [...this.chatMappings.entries()],
                        userMappings: [...this.userMappings.entries()],
                        contactMappings: [...this.contactMappings.entries()],
                        statusMappings: [...this.statusMappings.entries()],
                        topicMappings: [...this.topicMappings.entries()],
                        updatedAt: new Date()
                    }
                },
                { upsert: true }
            );
        } catch (error) {
            logger.error('❌ Error saving mappings to database:', error);
        }
    }

    async shutdown() {
        try {
            logger.info('🛑 Shutting down Telegram Bridge...');
            
            if (this.telegramBot) {
                await this.telegramBot.stopPolling();
            }
            
            await this.saveMappingsToDb();
            
            logger.info('✅ Telegram Bridge shutdown complete');
        } catch (error) {
            logger.error('❌ Error during Telegram Bridge shutdown:', error);
        }
    }
}

module.exports = TelegramBridge;