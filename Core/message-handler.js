const logger = require('./logger');
const config = require('../config');
const rateLimiter = require('./rate-limiter');

class MessageHandler {
    constructor(bot) {
        this.bot = bot;
        this.commandHandlers = new Map();
    }

    registerCommandHandler(command, handler) {
        this.commandHandlers.set(command.toLowerCase(), handler);
        logger.debug(`📝 Registered command handler: ${command}`);
    }

    async handleMessages({ messages, type }) {
        if (type !== 'notify') return;

        for (const msg of messages) {
            try {
                await this.processMessage(msg);
            } catch (error) {
                logger.error('Error processing message:', error);
            }
        }
    }

    async processMessage(msg) {
        // Handle status messages
        if (msg.key.remoteJid === 'status@broadcast') {
            return this.handleStatusMessage(msg);
        }

        // Extract text from message (including captions)
        const text = this.extractText(msg);
        
        // Check if it's a command (only for text messages, not media with captions)
        const prefix = config.get('bot.prefix');
        const isCommand = text && text.startsWith(prefix) && !this.hasMedia(msg);
        
        if (isCommand) {
            await this.handleCommand(msg, text);
        } else {
            // Handle non-command messages (including media)
            await this.handleNonCommandMessage(msg, text);
        }

        // FIXED: ALWAYS sync to Telegram if bridge is active (this was the main issue)
        if (this.bot.telegramBridge) {
            await this.bot.telegramBridge.syncMessage(msg, text);
        }
    }

    // New method to check if message has media
    hasMedia(msg) {
        return !!(
            msg.message?.imageMessage ||
            msg.message?.videoMessage ||
            msg.message?.audioMessage ||
            msg.message?.documentMessage ||
            msg.message?.stickerMessage ||
            msg.message?.locationMessage ||
            msg.message?.contactMessage
        );
    }

    async handleStatusMessage(msg) {
        if (config.get('features.autoViewStatus')) {
            try {
                await this.bot.sock.readMessages([msg.key]);
                await this.bot.sock.sendMessage(msg.key.remoteJid, {
                    react: { key: msg.key, text: '❤️' }
                });
                logger.debug(`❤️ Liked status from ${msg.key.participant}`);
            } catch (error) {
                logger.error('Error handling status:', error);
            }
        }
        
        // Also sync status messages to Telegram
        if (this.bot.telegramBridge) {
            const text = this.extractText(msg);
            await this.bot.telegramBridge.syncMessage(msg, text);
        }
    }

async handleCommand(msg, text) {
    const sender = msg.key.remoteJid;
    const participant = msg.key.participant || sender;
    const prefix = config.get('bot.prefix');

    const args = text.slice(prefix.length).trim().split(/\s+/);
    const command = args[0].toLowerCase();
    const params = args.slice(1);

if (!this.checkPermissions(msg, command)) {
    if (config.get('features.sendPermissionError', false)) {
        return this.bot.sendMessage(sender, {
            text: '❌ You don\'t have permission to use this command.'
        });
    }
    return; // silently ignore
}


    const userId = participant.split('@')[0];
    if (config.get('features.rateLimiting')) {
        const canExecute = await rateLimiter.checkCommandLimit(userId);
        if (!canExecute) {
            const remainingTime = await rateLimiter.getRemainingTime(userId);
            return this.bot.sendMessage(sender, {
                text: `⏱️ Rate limit exceeded. Try again in ${Math.ceil(remainingTime / 1000)} seconds.`
            });
        }
    }

    const handler = this.commandHandlers.get(command);
    const respondToUnknown = config.get('features.respondToUnknownCommands', false);

    if (handler) {
        try {
            await handler.execute(msg, params, {
                bot: this.bot,
                sender,
                participant,
                isGroup: sender.endsWith('@g.us')
            });

            logger.info(`✅ Command executed: ${command} by ${participant}`);

            if (this.bot.telegramBridge) {
                await this.bot.telegramBridge.logToTelegram('📝 Command Executed',
                    `Command: ${command}\nUser: ${participant}\nChat: ${sender}`);
            }

        } catch (error) {
            logger.error(`❌ Command failed: ${command}`, error);

            await this.bot.sendMessage(sender, {
                text: `❌ Command failed: ${error.message}`
            });

            if (this.bot.telegramBridge) {
                await this.bot.telegramBridge.logToTelegram('❌ Command Error',
                    `Command: ${command}\nError: ${error.message}\nUser: ${participant}`);
            }
        }

    } else if (respondToUnknown) {
        await this.bot.sendMessage(sender, {
            text: `❓ Unknown command: ${command}\nType *${prefix}menu* for available commands.`
        });
    }
}

    async handleNonCommandMessage(msg, text) {
        // Handle ViewOnce messages
        await this.handleViewOnceMessage(msg);
        
        // Log media messages for debugging
        if (this.hasMedia(msg)) {
            const mediaType = this.getMediaType(msg);
            logger.debug(`📎 Media message received: ${mediaType} from ${msg.key.participant || msg.key.remoteJid}`);
        } else if (text) {
            logger.debug('💬 Text message received:', text.substring(0, 50));
        }
    }

    async handleViewOnceMessage(msg) {
        try {
            // Check if this is a ViewOnce message
            if (msg.message && msg.message.viewOnceMessage) {
                const groupSet = global.db?.groups?.find(v => v.jid === msg.key.remoteJid);
                const isOwner = msg.key.participant === config.get('bot.owner') || msg.key.fromMe;
                
                // Only forward ViewOnce if viewonce feature is enabled for the group and sender is not owner
                if (groupSet && groupSet.viewonce && !isOwner) {
                    const viewOnceMsg = msg.message.viewOnceMessage.message;
                    let media = null;
                    let caption = this.extractText(msg) || '';
                    
                    // Download the media from ViewOnce message
                    if (viewOnceMsg.imageMessage) {
                        media = await this.bot.sock.downloadMediaMessage({
                            key: msg.key,
                            message: { imageMessage: viewOnceMsg.imageMessage }
                        });
                        
                        if (media) {
                            await this.bot.sock.sendMessage(msg.key.remoteJid, {
                                image: media,
                                caption: caption || ''
                            });
                            logger.info(`📸 ViewOnce image forwarded in ${msg.key.remoteJid}`);
                        }
                    } else if (viewOnceMsg.videoMessage) {
                        media = await this.bot.sock.downloadMediaMessage({
                            key: msg.key,
                            message: { videoMessage: viewOnceMsg.videoMessage }
                        });
                        
                        if (media) {
                            await this.bot.sock.sendMessage(msg.key.remoteJid, {
                                video: media,
                                caption: caption || ''
                            });
                            logger.info(`🎥 ViewOnce video forwarded in ${msg.key.remoteJid}`);
                        }
                    }
                }
            }
        } catch (error) {
            logger.error('Error handling ViewOnce message:', error);
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
        if (msg.message?.viewOnceMessage) return 'viewonce';
        return 'unknown';
    }

checkPermissions(msg, commandName) {
    const participant = msg.key.participant || msg.key.remoteJid;
    const userId = participant.split('@')[0];
    const ownerId = config.get('bot.owner').split('@')[0]; // Convert full JID to userId
    const isOwner = userId === ownerId || msg.key.fromMe;

    const admins = config.get('bot.admins') || [];

    const mode = config.get('features.mode');
    if (mode === 'private' && !isOwner && !admins.includes(userId)) return false;

    const blockedUsers = config.get('security.blockedUsers') || [];
    if (blockedUsers.includes(userId)) return false;

    const handler = this.commandHandlers.get(commandName);
    if (!handler) return false;

    const permission = handler.permissions || 'public';

    switch (permission) {
        case 'owner':
            return isOwner;

        case 'admin':
            return isOwner || admins.includes(userId);

        case 'public':
            return true;

        default:
            if (Array.isArray(permission)) {
                return permission.includes(userId);
            }
            return false;
    }
}


    extractText(msg) {
        return msg.message?.conversation || 
               msg.message?.extendedTextMessage?.text || 
               msg.message?.imageMessage?.caption ||
               msg.message?.videoMessage?.caption || 
               msg.message?.documentMessage?.caption ||
               msg.message?.audioMessage?.caption ||
               msg.message?.viewOnceMessage?.message?.imageMessage?.caption ||
               msg.message?.viewOnceMessage?.message?.videoMessage?.caption ||
               '';
    }
}

module.exports = MessageHandler;
