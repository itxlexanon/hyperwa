const { connectDb } = require('../utils/db');
const logger = require('../Core/logger');
const config = require('../config');

class BridgeCore {
    constructor() {
        this.db = null;
        this.collection = null;
        this.chatMappings = new Map();
        this.userMappings = new Map();
        this.contactMappings = new Map();
        this.profilePicCache = new Map();
        this.topicVerificationCache = new Map();
        
        // Queue management from watgbridge patterns
        this.messageQueue = new Map();
        this.readReceiptQueue = new Map();
        this.presenceQueue = new Map();
        this.lastPresenceUpdate = new Map();
        this.messageIdPairs = new Map();
        this.unreadMessages = new Map();
        
        // Rate limiting and retry logic
        this.rateLimitQueue = [];
        this.isProcessingQueue = false;
        this.maxRetries = 3;
        this.retryDelay = 1000;
        
        // Message processing state
        this.processingMessages = new Set();
        this.failedMessages = new Map();
    }

    async initializeDatabase() {
        try {
            this.db = await connectDb();
            await this.db.command({ ping: 1 });
            logger.info('✅ MongoDB connection successful');
            
            this.collection = this.db.collection('bridge');
            
            // Create indexes for better performance
            await this.collection.createIndex({ type: 1, 'data.whatsappJid': 1 }, { 
                unique: true, 
                partialFilterExpression: { type: 'chat' } 
            });
            await this.collection.createIndex({ type: 1, 'data.whatsappId': 1 }, { 
                unique: true, 
                partialFilterExpression: { type: 'user' } 
            });
            await this.collection.createIndex({ type: 1, 'data.phone': 1 }, { 
                unique: true, 
                partialFilterExpression: { type: 'contact' } 
            });
            await this.collection.createIndex({ type: 1, 'data.messageId': 1 }, { 
                unique: true, 
                partialFilterExpression: { type: 'message_pair' } 
            });
            
            logger.info('📊 Database initialized with indexes');
        } catch (error) {
            logger.error('❌ Failed to initialize database:', error);
            throw error;
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
                    case 'message_pair':
                        this.messageIdPairs.set(mapping.data.messageId, {
                            whatsappId: mapping.data.whatsappId,
                            telegramId: mapping.data.telegramId,
                            chatJid: mapping.data.chatJid,
                            topicId: mapping.data.topicId,
                            timestamp: mapping.data.timestamp,
                            markRead: mapping.data.markRead || false
                        });
                        break;
                }
            }
            
            logger.info(`📊 Loaded mappings: ${this.chatMappings.size} chats, ${this.userMappings.size} users, ${this.contactMappings.size} contacts, ${this.messageIdPairs.size} message pairs`);
        } catch (error) {
            logger.error('❌ Failed to load mappings:', error);
        }
    }

    // Enhanced message ID pairing system from watgbridge
    async addMessageIdPair(waMessageId, participantId, waChatId, tgChatId, tgMessageId, tgThreadId) {
        try {
            const pairData = {
                messageId: waMessageId,
                whatsappId: waMessageId,
                telegramId: tgMessageId,
                participantId: participantId,
                chatJid: waChatId,
                topicId: tgThreadId,
                tgChatId: tgChatId,
                timestamp: new Date(),
                markRead: false
            };

            await this.collection.updateOne(
                { type: 'message_pair', 'data.messageId': waMessageId },
                { 
                    $set: { 
                        type: 'message_pair',
                        data: pairData
                    } 
                },
                { upsert: true }
            );

            this.messageIdPairs.set(waMessageId, pairData);
            logger.debug(`✅ Saved message pair: WA(${waMessageId}) <-> TG(${tgMessageId})`);
        } catch (error) {
            logger.error('❌ Failed to save message pair:', error);
        }
    }

    async getWhatsAppFromTelegram(tgChatId, tgMessageId, tgThreadId) {
        try {
            for (const [messageId, pair] of this.messageIdPairs.entries()) {
                if (pair.tgChatId === tgChatId && 
                    pair.telegramId === tgMessageId && 
                    pair.topicId === tgThreadId) {
                    return {
                        messageId: pair.whatsappId,
                        participantId: pair.participantId,
                        chatId: pair.chatJid
                    };
                }
            }
            return null;
        } catch (error) {
            logger.error('❌ Failed to get WhatsApp message from Telegram:', error);
            return null;
        }
    }

    async getTelegramFromWhatsApp(waMessageId, waChatId) {
        try {
            const pair = this.messageIdPairs.get(waMessageId);
            if (pair && pair.chatJid === waChatId) {
                return {
                    tgChatId: pair.tgChatId,
                    tgThreadId: pair.topicId,
                    tgMessageId: pair.telegramId
                };
            }
            return null;
        } catch (error) {
            logger.error('❌ Failed to get Telegram message from WhatsApp:', error);
            return null;
        }
    }

    // Queue management system
    async queueMessage(messageData, priority = 0) {
        const messageId = messageData.id || `${Date.now()}_${Math.random()}`;
        
        if (this.processingMessages.has(messageId)) {
            logger.debug(`Message ${messageId} already being processed`);
            return;
        }

        this.messageQueue.set(messageId, {
            ...messageData,
            id: messageId,
            priority,
            timestamp: Date.now(),
            retries: 0
        });

        this.processMessageQueue();
    }

    async processMessageQueue() {
        if (this.isProcessingQueue) return;
        
        this.isProcessingQueue = true;
        
        try {
            // Sort by priority and timestamp
            const sortedMessages = Array.from(this.messageQueue.entries())
                .sort(([, a], [, b]) => {
                    if (a.priority !== b.priority) return b.priority - a.priority;
                    return a.timestamp - b.timestamp;
                });

            for (const [messageId, messageData] of sortedMessages) {
                if (this.processingMessages.has(messageId)) continue;
                
                this.processingMessages.add(messageId);
                
                try {
                    await this.processQueuedMessage(messageData);
                    this.messageQueue.delete(messageId);
                } catch (error) {
                    await this.handleMessageError(messageId, messageData, error);
                } finally {
                    this.processingMessages.delete(messageId);
                }
                
                // Rate limiting - small delay between messages
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        } finally {
            this.isProcessingQueue = false;
        }
    }

    async processQueuedMessage(messageData) {
        switch (messageData.type) {
            case 'whatsapp_to_telegram':
                await this.processWhatsAppMessage(messageData);
                break;
            case 'telegram_to_whatsapp':
                await this.processTelegramMessage(messageData);
                break;
            case 'read_receipt':
                await this.processReadReceipt(messageData);
                break;
            case 'presence_update':
                await this.processPresenceUpdate(messageData);
                break;
            default:
                logger.warn(`Unknown message type: ${messageData.type}`);
        }
    }

    async handleMessageError(messageId, messageData, error) {
        messageData.retries = (messageData.retries || 0) + 1;
        
        if (messageData.retries >= this.maxRetries) {
            logger.error(`❌ Message ${messageId} failed after ${this.maxRetries} retries:`, error);
            this.failedMessages.set(messageId, { messageData, error, timestamp: Date.now() });
            this.messageQueue.delete(messageId);
        } else {
            logger.warn(`⚠️ Message ${messageId} failed, retry ${messageData.retries}/${this.maxRetries}:`, error.message);
            // Exponential backoff
            const delay = this.retryDelay * Math.pow(2, messageData.retries - 1);
            setTimeout(() => {
                this.messageQueue.set(messageId, messageData);
                this.processMessageQueue();
            }, delay);
        }
    }

    // Read receipt queue management
    queueReadReceipt(chatJid, messageKey) {
        if (!config.get('telegram.features.readReceipts')) return;
        
        if (!this.readReceiptQueue.has(chatJid)) {
            this.readReceiptQueue.set(chatJid, []);
        }
        
        this.readReceiptQueue.get(chatJid).push({
            key: messageKey,
            timestamp: Date.now()
        });
        
        // Process read receipts after a delay to batch them
        setTimeout(() => {
            this.processReadReceipts(chatJid);
        }, 2000);
    }

    async processReadReceipts(chatJid) {
        try {
            const receipts = this.readReceiptQueue.get(chatJid);
            if (!receipts || receipts.length === 0) return;
            
            const messageKeys = receipts.map(r => r.key);
            
            if (this.whatsappBot?.sock) {
                await this.whatsappBot.sock.readMessages(messageKeys);
                logger.debug(`📖 Marked ${messageKeys.length} messages as read in ${chatJid}`);
                
                // Update message pairs as read
                for (const key of messageKeys) {
                    const pair = this.messageIdPairs.get(key.id);
                    if (pair) {
                        pair.markRead = true;
                        await this.collection.updateOne(
                            { type: 'message_pair', 'data.messageId': key.id },
                            { $set: { 'data.markRead': true } }
                        );
                    }
                }
            }
            
            this.readReceiptQueue.set(chatJid, []);
        } catch (error) {
            logger.debug('Failed to process read receipts:', error);
        }
    }

    // Get unread messages for a chat
    async getUnreadMessages(waChatId) {
        try {
            const unreadPairs = new Map();
            
            for (const [messageId, pair] of this.messageIdPairs.entries()) {
                if (pair.chatJid === waChatId && !pair.markRead) {
                    if (!unreadPairs.has(pair.participantId)) {
                        unreadPairs.set(pair.participantId, []);
                    }
                    unreadPairs.get(pair.participantId).push(messageId);
                }
            }
            
            return unreadPairs;
        } catch (error) {
            logger.error('❌ Failed to get unread messages:', error);
            return new Map();
        }
    }

    // Presence management with throttling
    async queuePresenceUpdate(jid, presenceType = 'available') {
        if (!config.get('telegram.features.presenceUpdates')) return;
        
        const now = Date.now();
        const lastUpdate = this.lastPresenceUpdate.get(jid) || 0;
        
        // Throttle presence updates to max 1 per second per JID
        if (now - lastUpdate < 1000) return;
        
        this.lastPresenceUpdate.set(jid, now);
        
        await this.queueMessage({
            type: 'presence_update',
            jid,
            presenceType,
            timestamp: now
        }, 1); // Lower priority than messages
    }

    async processPresenceUpdate(messageData) {
        try {
            if (this.whatsappBot?.sock) {
                await this.whatsappBot.sock.sendPresenceUpdate(messageData.presenceType, messageData.jid);
                logger.debug(`👁️ Sent presence update: ${messageData.presenceType} to ${messageData.jid}`);
            }
        } catch (error) {
            logger.debug('Failed to send presence update:', error);
        }
    }

    // Enhanced topic verification with caching
    async verifyTopicExists(jid, topicId) {
        try {
            const cacheKey = `${jid}_${topicId}`;
            
            // Check cache first (valid for 5 minutes)
            const cached = this.topicVerificationCache.get(cacheKey);
            if (cached && (Date.now() - cached.timestamp) < 300000) {
                return cached.exists;
            }
            
            // For now, assume topic exists if we have it in mapping
            // Telegram Bot API doesn't provide direct topic verification
            const exists = this.chatMappings.has(jid) && this.chatMappings.get(jid) === topicId;
            
            this.topicVerificationCache.set(cacheKey, {
                exists,
                timestamp: Date.now()
            });
            
            return exists;
        } catch (error) {
            logger.debug('Failed to verify topic existence:', error);
            return false;
        }
    }

    // Database operations
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
            this.topicVerificationCache.delete(`${whatsappJid}_${telegramTopicId}`);
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

    // Utility methods
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

    // Cleanup methods
    async cleanupOldData() {
        try {
            const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            
            // Clean old message pairs
            await this.collection.deleteMany({
                type: 'message_pair',
                'data.timestamp': { $lt: oneWeekAgo }
            });
            
            // Clean old failed messages
            for (const [messageId, failedData] of this.failedMessages.entries()) {
                if (failedData.timestamp < oneWeekAgo.getTime()) {
                    this.failedMessages.delete(messageId);
                }
            }
            
            logger.info('🧹 Cleaned up old data');
        } catch (error) {
            logger.error('❌ Failed to cleanup old data:', error);
        }
    }

    async shutdown() {
        logger.info('🛑 Shutting down Bridge Core...');
        
        // Process remaining messages
        if (this.messageQueue.size > 0) {
            logger.info(`📤 Processing ${this.messageQueue.size} remaining messages...`);
            await this.processMessageQueue();
        }
        
        // Process remaining read receipts
        for (const chatJid of this.readReceiptQueue.keys()) {
            await this.processReadReceipts(chatJid);
        }
        
        logger.info('✅ Bridge Core shutdown complete');
    }
}

module.exports = BridgeCore;
