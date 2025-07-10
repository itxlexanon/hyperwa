const logger = require('./logger');
const config = require('../config');
const rateLimiter = require('./rate-limiter');

class MessageHandler {
    constructor(bot) {
        this.bot = bot;
        this.commandHandlers = new Map();
        this.messageHooks = new Map();
        logger.debug('MessageHandler initialized');
    }

    registerCommandHandler(command, handler) {
        if (!command || typeof handler !== 'object' || typeof handler.execute !== 'function') {
            logger.error(`Invalid command handler for ${command}`);
            return;
        }
        this.commandHandlers.set(command.toLowerCase(), handler);
        logger.debug(`📝 Registered command handler: ${command}`);
    }

    registerMessageHook(hook, handler) {
        if (!hook || typeof hook !== 'string') {
            logger.error('Invalid hook name:', hook);
            return;
        }
        if (typeof handler !== 'function') {
            logger.error(`Invalid handler for hook ${hook}`);
            return;
        }
        this.messageHooks.set(hook, handler);
        logger.debug(`📝 Registered message hook: ${hook}`);
    }

    unregisterMessageHook(hook) {
        this.messageHooks.delete(hook);
        logger.debug(`🗑️ Unregistered message hook: ${hook}`);
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
        if (!msg || !msg.key) {
            logger.warn('Invalid message received');
            return;
        }

        // Run message hooks
        const context = {
            bot: this.bot,
            sender: msg.key.remoteJid,
            participant: msg.key.participant || msg.key.remoteJid,
            isOwner: this.checkPermissions(msg, 'public')
        };
        for (const [hook, handler] of this.messageHooks) {
            try {
                if (typeof handler !== 'function') {
                    logger.error(`Invalid handler for hook ${hook}`);
                    continue;
                }
                await handler(msg, context);
                logger.debug(`Executed hook: ${hook}`);
            } catch (error) {
                logger.error(`Error in message hook ${hook}: ${error.message}`, {
                    stack: error.stack,
                    messageId: msg.key.id,
                    hook
                });
            }
        }

        if (msg.key.remoteJid === 'status@broadcast') {
            return this.handleStatusMessage(msg);
        }

        const text = this.extractText(msg);
        const prefix = config.get('bot.prefix');
        const isCommand = text && text.startsWith(prefix) && !this.hasMedia(msg);
        
        if (isCommand) {
            logger.debug(`Processing command: ${text}`);
            await this.handleCommand(msg, text);
        } else {
            await this.handleNonCommandMessage(msg, text);
        }

        if (this.bot.telegramBridge) {
            await this.bot.telegramBridge.syncMessage(msg, text);
        }
    }

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

        logger.debug(`Checking permissions for command: ${command} by ${participant}`);
        if (!this.checkPermissions(msg, command)) {
            logger.debug(`Permission denied for ${participant} on command ${command}`);
            if (config.get('features.sendPermissionError', false)) {
                return this.bot.sendMessage(sender, {
                    text: '❌ You don\'t have permission to use this command.'
                });
            }
            return;
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
            logger.debug(`Executing command: ${command} with params: ${params.join(' ')}`);
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
            logger.debug(`Unknown command: ${command}`);
            await this.bot.sendMessage(sender, {
                text: `❓ Unknown command: ${command}\nType *${prefix}menu* for available commands.`
            });
        }
    }

    async handleNonCommandMessage(msg, text) {
        if (this.hasMedia(msg)) {
            const mediaType = this.getMediaType(msg);
            logger.debug(`📎 Media message received: ${mediaType} from ${msg.key.participant || msg.key.remoteJid}`);
        } else if (text) {
            logger.debug('💬 Text message received:', text.substring(0, 50));
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
        return 'unknown';
    }

    checkPermissions(msg, commandName) {
        const participant = msg.key.participant || msg.key.remoteJid;
        const userId = participant.split('@')[0];
        const ownerId = config.get('bot.owner').split('@')[0];
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
            case 'owner': return isOwner;
            case 'admin': return isOwner || admins.includes(userId);
            case 'public': return true;
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
               '';
    }
}

module.exports = MessageHandler;
