const TelegramBot = require('node-telegram-bot-api');
const logger = require('../Core/logger');
const config = require('../config');
const { connectDb } = require('../utils/db');
const TelegramCommands = require('./commands');

class TelegramBridge {
    constructor(whatsappBot) {
        this.whatsappBot = whatsappBot;
        this.telegramBot = null;
        this.chatMappings = new Map();
        this.userMappings = new Map();
        this.contactMappings = new Map();
        this.db = null;
        this.commands = null;
        this.isShuttingDown = false;
        this.silentTopicRenames = new Set(); // Track silent topic renames
    }

    async initialize() {
        try {
            this.db = await connectDb();
            
            const token = config.get('telegram.botToken');
            const chatId = config.get('telegram.chatId');

            if (!token || !chatId) {
                throw new Error('Telegram bot token or chat ID not configured');
            }

            this.telegramBot = new TelegramBot(token, { polling: true });
            this.commands = new TelegramCommands(this);

            // Load message filters
            await this.commands.loadFiltersFromDb();

            // Load existing mappings
            await this.loadMappingsFromDb();

            // Setup event handlers
            this.setupTelegramHandlers();

            // Register bot commands
            await this.commands.registerBotCommands();

            logger.info('✅ Telegram bridge initialized successfully');
        } catch (error) {
            logger.error('❌ Failed to initialize Telegram bridge:', error);
            throw error;
        }
    }

    setupTelegramHandlers() {
        // Handle commands
        this.telegramBot.on('message', async (msg) => {
            try {
                if (msg.text && msg.text.startsWith('/')) {
                    await this.commands.handleCommand(msg);
                    return;
                }

                // Handle regular messages (forward to WhatsApp)
                await this.handleTelegramMessage(msg);
            } catch (error) {
                logger.error('❌ Error handling Telegram message:', error);
            }
        });

        // Handle callback queries (inline buttons)
        this.telegramBot.on('callback_query', async (query) => {
            try {
                await this.handleCallbackQuery(query);
            } catch (error) {
                logger.error('❌ Error handling callback query:', error);
            }
        });

        // Handle errors
        this.telegramBot.on('error', (error) => {
            logger.error('❌ Telegram bot error:', error);
        });

        // Handle polling errors
        this.telegramBot.on('polling_error', (error) => {
            logger.error('❌ Telegram polling error:', error);
        });
    }

    async handleTelegramMessage(msg) {
        if (this.isShuttingDown) return;

        const chatId = config.get('telegram.chatId');
        if (msg.chat.id.toString() !== chatId.toString()) return;

        // Check if message should be filtered
        if (msg.text && this.commands.shouldFilterMessage(msg.text)) {
            logger.debug(`🚫 Message filtered: "${msg.text.substring(0, 50)}..."`);
            return;
        }

        // Handle topic messages (replies in forum)
        if (msg.message_thread_id) {
            await this.handleTopicMessage(msg);
            return;
        }

        // Handle direct messages to main chat
        if (msg.text) {
            await this.logToTelegram('💬 Direct Message', `Message: ${msg.text}`);
        }
    }

    async handleTopicMessage(msg) {
        const topicId = msg.message_thread_id;
        
        // Find WhatsApp chat for this topic
        let targetJid = null;
        for (const [jid, tId] of this.chatMappings) {
            if (tId === topicId) {
                targetJid = jid;
                break;
            }
        }

        if (!targetJid) {
            logger.warn(`⚠️ No WhatsApp chat found for topic ${topicId}`);
            return;
        }

        try {
            if (msg.text) {
                // Send text message
                await this.whatsappBot.sendMessage(targetJid, { text: msg.text });
                logger.debug(`📤 Sent text to WhatsApp: ${targetJid}`);
            } else if (msg.photo) {
                // Handle photo
                const photo = msg.photo[msg.photo.length - 1]; // Get highest resolution
                const fileLink = await this.telegramBot.getFileLink(photo.file_id);
                
                await this.whatsappBot.sendMessage(targetJid, {
                    image: { url: fileLink },
                    caption: msg.caption || ''
                });
                logger.debug(`📤 Sent photo to WhatsApp: ${targetJid}`);
            } else if (msg.video) {
                // Handle video
                const fileLink = await this.telegramBot.getFileLink(msg.video.file_id);
                
                await this.whatsappBot.sendMessage(targetJid, {
                    video: { url: fileLink },
                    caption: msg.caption || ''
                });
                logger.debug(`📤 Sent video to WhatsApp: ${targetJid}`);
            } else if (msg.document) {
                // Handle document
                const fileLink = await this.telegramBot.getFileLink(msg.document.file_id);
                
                await this.whatsappBot.sendMessage(targetJid, {
                    document: { url: fileLink },
                    fileName: msg.document.file_name || 'document',
                    caption: msg.caption || ''
                });
                logger.debug(`📤 Sent document to WhatsApp: ${targetJid}`);
            } else if (msg.audio) {
                // Handle audio
                const fileLink = await this.telegramBot.getFileLink(msg.audio.file_id);
                
                await this.whatsappBot.sendMessage(targetJid, {
                    audio: { url: fileLink },
                    caption: msg.caption || ''
                });
                logger.debug(`📤 Sent audio to WhatsApp: ${targetJid}`);
            } else if (msg.voice) {
                // Handle voice note
                const fileLink = await this.telegramBot.getFileLink(msg.voice.file_id);
                
                await this.whatsappBot.sendMessage(targetJid, {
                    audio: { url: fileLink },
                    ptt: true
                });
                logger.debug(`📤 Sent voice note to WhatsApp: ${targetJid}`);
            } else if (msg.sticker) {
                // Handle sticker
                const fileLink = await this.telegramBot.getFileLink(msg.sticker.file_id);
                
                await this.whatsappBot.sendMessage(targetJid, {
                    sticker: { url: fileLink }
                });
                logger.debug(`📤 Sent sticker to WhatsApp: ${targetJid}`);
            }
        } catch (error) {
            logger.error(`❌ Failed to forward message to WhatsApp ${targetJid}:`, error);
            await this.telegramBot.sendMessage(msg.chat.id, 
                `❌ Failed to send message to WhatsApp: ${error.message}`,
                { message_thread_id: topicId }
            );
        }
    }

    async handleCallbackQuery(query) {
        const data = query.data;
        
        if (data.startsWith('contact_')) {
            const phone = data.replace('contact_', '');
            const jid = `${phone}@s.whatsapp.net`;
            
            // Create or get topic for this contact
            const topicId = await this.getOrCreateTopic(jid);
            
            await this.telegramBot.answerCallbackQuery(query.id, {
                text: `Opening chat with ${this.contactMappings.get(phone) || phone}`,
                show_alert: false
            });
            
            // Send a message to the topic
            await this.telegramBot.sendMessage(config.get('telegram.chatId'),
                `💬 Chat opened with ${this.contactMappings.get(phone) || phone} (+${phone})`,
                { message_thread_id: topicId }
            );
        }
    }

    async syncMessage(msg, text) {
        if (this.isShuttingDown) return;

        try {
            const chatId = config.get('telegram.chatId');
            if (!chatId) return;

            const sender = msg.key.remoteJid;
            const participant = msg.key.participant || sender;
            const isGroup = sender.endsWith('@g.us');
            const isStatus = sender === 'status@broadcast';

            // Get or create topic for this chat
            const topicId = await this.getOrCreateTopic(sender);
            if (!topicId) return;

            // Get sender info
            const senderInfo = await this.getSenderInfo(participant, isGroup);
            
            // Format message
            let messageText = '';
            
            if (isStatus) {
                messageText = `📱 *Status Update*\n👤 ${senderInfo.name}\n\n`;
            } else if (isGroup) {
                messageText = `👥 *${senderInfo.groupName}*\n👤 ${senderInfo.name}\n\n`;
            } else {
                messageText = `👤 *${senderInfo.name}*\n\n`;
            }

            // Add message content
            if (text) {
                messageText += text;
            }

            // Handle media
            if (msg.message?.imageMessage) {
                await this.forwardMedia(msg.message.imageMessage, 'photo', topicId, messageText);
            } else if (msg.message?.videoMessage) {
                await this.forwardMedia(msg.message.videoMessage, 'video', topicId, messageText);
            } else if (msg.message?.audioMessage) {
                await this.forwardMedia(msg.message.audioMessage, 'audio', topicId, messageText);
            } else if (msg.message?.documentMessage) {
                await this.forwardMedia(msg.message.documentMessage, 'document', topicId, messageText);
            } else if (msg.message?.stickerMessage) {
                await this.forwardMedia(msg.message.stickerMessage, 'sticker', topicId, messageText);
            } else if (text) {
                // Send text message
                await this.telegramBot.sendMessage(chatId, messageText, {
                    message_thread_id: topicId,
                    parse_mode: 'Markdown'
                });
            }

            // Update user stats
            this.updateUserStats(participant);

        } catch (error) {
            logger.error('❌ Error syncing message to Telegram:', error);
        }
    }

    async forwardMedia(mediaMessage, type, topicId, caption) {
        try {
            const chatId = config.get('telegram.chatId');
            const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
            
            const stream = await downloadContentFromMessage(mediaMessage, type === 'sticker' ? 'sticker' : type);
            const chunks = [];
            for await (const chunk of stream) {
                chunks.push(chunk);
            }
            const buffer = Buffer.concat(chunks);

            const options = {
                message_thread_id: topicId,
                caption: caption || '',
                parse_mode: 'Markdown'
            };

            switch (type) {
                case 'photo':
                    await this.telegramBot.sendPhoto(chatId, buffer, options);
                    break;
                case 'video':
                    await this.telegramBot.sendVideo(chatId, buffer, options);
                    break;
                case 'audio':
                    if (mediaMessage.ptt) {
                        await this.telegramBot.sendVoice(chatId, buffer, options);
                    } else {
                        await this.telegramBot.sendAudio(chatId, buffer, options);
                    }
                    break;
                case 'document':
                    options.filename = mediaMessage.fileName || 'document';
                    await this.telegramBot.sendDocument(chatId, buffer, options);
                    break;
                case 'sticker':
                    await this.telegramBot.sendSticker(chatId, buffer, options);
                    break;
            }
        } catch (error) {
            logger.error(`❌ Error forwarding ${type}:`, error);
        }
    }

    async getOrCreateTopic(jid) {
        try {
            // Check if topic already exists
            if (this.chatMappings.has(jid)) {
                return this.chatMappings.get(jid);
            }

            const chatId = config.get('telegram.chatId');
            const topicName = await this.getTopicName(jid);

            // Create new topic
            const topic = await this.telegramBot.createForumTopic(chatId, topicName);
            const topicId = topic.message_thread_id;

            // Store mapping
            this.chatMappings.set(jid, topicId);
            await this.saveMappingsToDb();

            logger.info(`✅ Created topic "${topicName}" (ID: ${topicId}) for ${jid}`);
            return topicId;

        } catch (error) {
            logger.error(`❌ Error creating topic for ${jid}:`, error);
            return null;
        }
    }

    async getTopicName(jid) {
        if (jid === 'status@broadcast') {
            return '📱 Status Updates';
        }

        if (jid.endsWith('@g.us')) {
            // Group chat
            try {
                const groupMetadata = await this.whatsappBot.sock.groupMetadata(jid);
                return `👥 ${groupMetadata.subject}`;
            } catch {
                return `👥 Group ${jid.split('@')[0]}`;
            }
        } else {
            // Individual chat
            const phone = jid.split('@')[0];
            const contactName = this.contactMappings.get(phone);
            return contactName ? `👤 ${contactName}` : `👤 +${phone}`;
        }
    }

    async renameTopicSilently(jid, newName) {
        try {
            const topicId = this.chatMappings.get(jid);
            if (!topicId) return;

            const chatId = config.get('telegram.chatId');
            
            // Mark this rename as silent
            this.silentTopicRenames.add(topicId);
            
            // Rename the topic
            await this.telegramBot.editForumTopic(chatId, topicId, newName);
            
            // Remove from silent set after a short delay
            setTimeout(() => {
                this.silentTopicRenames.delete(topicId);
            }, 5000);

            logger.debug(`🔄 Silently renamed topic ${topicId} to "${newName}"`);
        } catch (error) {
            logger.error(`❌ Error renaming topic for ${jid}:`, error);
        }
    }

    async getSenderInfo(participant, isGroup) {
        const phone = participant.split('@')[0];
        const contactName = this.contactMappings.get(phone);
        
        let info = {
            name: contactName || `+${phone}`,
            phone: phone
        };

        if (isGroup) {
            try {
                const groupJid = participant.includes('-') ? 
                    participant.split('-')[0] + '@g.us' : 
                    participant;
                const groupMetadata = await this.whatsappBot.sock.groupMetadata(groupJid);
                info.groupName = groupMetadata.subject;
            } catch {
                info.groupName = 'Unknown Group';
            }
        }

        return info;
    }

    async syncContacts() {
        try {
            const store = this.whatsappBot.sock.store;
            if (!store || !store.contacts) {
                logger.warn('⚠️ WhatsApp store not available for contact sync');
                return;
            }

            const contacts = Object.values(store.contacts);
            let syncedCount = 0;

            for (const contact of contacts) {
                if (contact.id && !contact.id.endsWith('@g.us')) {
                    const phone = contact.id.split('@')[0];
                    const name = contact.name || contact.notify || contact.verifiedName;
                    
                    if (name && name !== phone) {
                        const oldName = this.contactMappings.get(phone);
                        this.contactMappings.set(phone, name);
                        
                        // Update topic name if it changed
                        if (oldName !== name) {
                            const jid = `${phone}@s.whatsapp.net`;
                            const newTopicName = `👤 ${name}`;
                            await this.renameTopicSilently(jid, newTopicName);
                        }
                        
                        syncedCount++;
                    }
                }
            }

            await this.saveMappingsToDb();
            logger.info(`✅ Synced ${syncedCount} contacts from WhatsApp`);

        } catch (error) {
            logger.error('❌ Error syncing contacts:', error);
            throw error;
        }
    }

    async sendQRCode(qr) {
        try {
            const chatId = config.get('telegram.chatId');
            if (!chatId) return;

            const qrcode = require('qrcode');
            const qrBuffer = await qrcode.toBuffer(qr, { width: 512 });

            await this.telegramBot.sendPhoto(chatId, qrBuffer, {
                caption: '📱 *WhatsApp QR Code*\n\nScan this QR code with WhatsApp to connect.',
                parse_mode: 'Markdown'
            });

            logger.info('✅ QR code sent to Telegram');
        } catch (error) {
            logger.error('❌ Error sending QR code to Telegram:', error);
        }
    }

    async logToTelegram(title, message) {
        try {
            const chatId = config.get('telegram.chatId');
            if (!chatId) return;

            const logMessage = `🔔 *${title}*\n\n${message}\n\n⏰ ${new Date().toLocaleString()}`;
            
            await this.telegramBot.sendMessage(chatId, logMessage, {
                parse_mode: 'Markdown'
            });
        } catch (error) {
            logger.error('❌ Error logging to Telegram:', error);
        }
    }

    async setupWhatsAppHandlers() {
        // This method is called when WhatsApp connects
        logger.info('🔗 Setting up WhatsApp handlers for Telegram bridge');
    }

    async syncWhatsAppConnection() {
        try {
            const user = this.whatsappBot.sock?.user;
            if (user) {
                await this.logToTelegram('✅ WhatsApp Connected', 
                    `Connected as: ${user.name || user.id}\nPhone: ${user.id}`);
            }
        } catch (error) {
            logger.error('❌ Error syncing WhatsApp connection:', error);
        }
    }

    updateUserStats(participant) {
        const phone = participant.split('@')[0];
        const user = this.userMappings.get(phone) || { messageCount: 0 };
        user.messageCount = (user.messageCount || 0) + 1;
        user.lastActivity = new Date();
        this.userMappings.set(phone, user);
    }

    async loadMappingsFromDb() {
        try {
            if (!this.db) return;

            const collection = this.db.collection('bridge_mappings');
            const mappings = await collection.find({}).toArray();

            for (const mapping of mappings) {
                switch (mapping.type) {
                    case 'chat':
                        this.chatMappings.set(mapping.whatsappJid, mapping.telegramTopicId);
                        break;
                    case 'contact':
                        this.contactMappings.set(mapping.phone, mapping.name);
                        break;
                    case 'user':
                        this.userMappings.set(mapping.phone, mapping.data);
                        break;
                }
            }

            logger.info(`✅ Loaded ${this.chatMappings.size} chat mappings, ${this.contactMappings.size} contacts, ${this.userMappings.size} users`);
        } catch (error) {
            logger.error('❌ Error loading mappings from database:', error);
        }
    }

    async saveMappingsToDb() {
        try {
            if (!this.db) return;

            const collection = this.db.collection('bridge_mappings');
            
            // Clear existing mappings
            await collection.deleteMany({});

            const mappings = [];

            // Save chat mappings
            for (const [whatsappJid, telegramTopicId] of this.chatMappings) {
                mappings.push({
                    type: 'chat',
                    whatsappJid,
                    telegramTopicId,
                    updatedAt: new Date()
                });
            }

            // Save contact mappings
            for (const [phone, name] of this.contactMappings) {
                mappings.push({
                    type: 'contact',
                    phone,
                    name,
                    updatedAt: new Date()
                });
            }

            // Save user mappings
            for (const [phone, data] of this.userMappings) {
                mappings.push({
                    type: 'user',
                    phone,
                    data,
                    updatedAt: new Date()
                });
            }

            if (mappings.length > 0) {
                await collection.insertMany(mappings);
            }

            logger.debug('✅ Saved mappings to database');
        } catch (error) {
            logger.error('❌ Error saving mappings to database:', error);
        }
    }

    async saveFiltersToDb() {
        try {
            if (!this.db) return;

            const collection = this.db.collection('bridge_settings');
            
            await collection.updateOne(
                { type: 'message_filters' },
                { 
                    $set: { 
                        filters: Array.from(this.commands.messageFilters),
                        updatedAt: new Date()
                    } 
                },
                { upsert: true }
            );

            logger.debug('✅ Saved message filters to database');
        } catch (error) {
            logger.error('❌ Error saving filters to database:', error);
            throw error;
        }
    }

    async shutdown() {
        logger.info('🛑 Shutting down Telegram bridge...');
        this.isShuttingDown = true;
        
        if (this.telegramBot) {
            await this.telegramBot.stopPolling();
        }
        
        await this.saveMappingsToDb();
        logger.info('✅ Telegram bridge shutdown complete');
    }
}

module.exports = TelegramBridge;