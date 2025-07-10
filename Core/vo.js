const logger = require('../logger');

class ViewOnceFeature {
    constructor(bot) {
        this.bot = bot;
        this.name = 'ViewOnce Handler';
        this.description = 'Automatically forwards ViewOnce messages when enabled';
    }

    async initialize() {
        logger.info('🔍 ViewOnce feature initialized');
        
        // Register viewonce command
        this.bot.messageHandler.registerCommandHandler('viewonce', {
            permissions: 'admin',
            execute: async (msg, params, context) => {
                await this.handleViewOnceCommand(msg, params, context);
            }
        });
    }

    async handleViewOnceCommand(msg, params, context) {
        const { bot, sender, isGroup } = context;
        
        if (!isGroup) {
            return bot.sendMessage(sender, {
                text: '❌ This command can only be used in groups.'
            });
        }

        const action = params[0]?.toLowerCase();
        
        if (!action || !['on', 'off', 'status'].includes(action)) {
            return bot.sendMessage(sender, {
                text: `🔍 *ViewOnce Feature*\n\n` +
                      `Usage: viewonce <on/off/status>\n\n` +
                      `• \`on\` - Enable ViewOnce forwarding\n` +
                      `• \`off\` - Disable ViewOnce forwarding\n` +
                      `• \`status\` - Check current status\n\n` +
                      `When enabled, ViewOnce messages will be automatically forwarded as regular messages.`
            });
        }

        // Initialize group settings if not exists
        if (!global.db) global.db = {};
        if (!global.db.groups) global.db.groups = [];
        
        let groupSet = global.db.groups.find(v => v.jid === sender);
        if (!groupSet) {
            groupSet = {
                jid: sender,
                viewonce: false,
                // Add other default group settings here
                antidelete: true,
                antilink: false,
                antivirtex: false,
                antitagsw: true,
                filter: false,
                left: false,
                localonly: false,
                mute: false,
                autosticker: true,
                member: {},
                text_left: '',
                text_welcome: '',
                welcome: true,
                expired: 0,
                stay: false,
                activity: new Date().getTime()
            };
            global.db.groups.push(groupSet);
        }

        switch (action) {
            case 'on':
                if (groupSet.viewonce) {
                    return bot.sendMessage(sender, {
                        text: '✅ ViewOnce forwarding is already enabled in this group.'
                    });
                }
                groupSet.viewonce = true;
                return bot.sendMessage(sender, {
                    text: '✅ ViewOnce forwarding has been enabled for this group.\n\n' +
                          '🔍 ViewOnce messages will now be automatically forwarded as regular messages.'
                });

            case 'off':
                if (!groupSet.viewonce) {
                    return bot.sendMessage(sender, {
                        text: '❌ ViewOnce forwarding is already disabled in this group.'
                    });
                }
                groupSet.viewonce = false;
                return bot.sendMessage(sender, {
                    text: '❌ ViewOnce forwarding has been disabled for this group.'
                });

            case 'status':
                const status = groupSet.viewonce ? '✅ Enabled' : '❌ Disabled';
                return bot.sendMessage(sender, {
                    text: `🔍 *ViewOnce Status*\n\n` +
                          `Status: ${status}\n\n` +
                          `Use \`viewonce on\` to enable or \`viewonce off\` to disable.`
                });
        }
    }

    async handleViewOnceMessage(msg) {
        try {
            // Check if this is a ViewOnce message
            if (!msg.message?.viewOnceMessage) return;

            const groupSet = global.db?.groups?.find(v => v.jid === msg.key.remoteJid);
            const isOwner = msg.key.participant === this.bot.sock.user?.id || msg.key.fromMe;
            
            // Only forward ViewOnce if feature is enabled for the group and sender is not owner
            if (!groupSet?.viewonce || isOwner) return;

            const viewOnceMsg = msg.message.viewOnceMessage.message;
            let caption = this.extractCaption(msg);
            
            // Handle image ViewOnce
            if (viewOnceMsg.imageMessage) {
                const media = await this.bot.sock.downloadMediaMessage({
                    key: msg.key,
                    message: { imageMessage: viewOnceMsg.imageMessage }
                });
                
                if (media) {
                    await this.bot.sock.sendMessage(msg.key.remoteJid, {
                        image: media,
                        caption: caption || '🔍 ViewOnce Image'
                    });
                    logger.info(`📸 ViewOnce image forwarded in ${msg.key.remoteJid}`);
                }
            }
            // Handle video ViewOnce
            else if (viewOnceMsg.videoMessage) {
                const media = await this.bot.sock.downloadMediaMessage({
                    key: msg.key,
                    message: { videoMessage: viewOnceMsg.videoMessage }
                });
                
                if (media) {
                    await this.bot.sock.sendMessage(msg.key.remoteJid, {
                        video: media,
                        caption: caption || '🔍 ViewOnce Video'
                    });
                    logger.info(`🎥 ViewOnce video forwarded in ${msg.key.remoteJid}`);
                }
            }
            
        } catch (error) {
            logger.error('Error handling ViewOnce message:', error);
        }
    }

    extractCaption(msg) {
        return msg.message?.viewOnceMessage?.message?.imageMessage?.caption ||
               msg.message?.viewOnceMessage?.message?.videoMessage?.caption ||
               '';
    }
}

module.exports = ViewOnceFeature;
