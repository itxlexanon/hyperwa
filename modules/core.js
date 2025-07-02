
const config = require('../config');
const fs = require('fs-extra');
const path = require('path');
const helpers = require('../utils/helpers');

class CoreCommands {
    constructor(bot) {
        this.bot = bot;
        this.name = 'core';
        this.metadata = {
            description: 'Core commands for HyperWa Userbot management and system information',
            version: '3.0.0',
            author: 'HyperWa Technologies',
            category: 'system',
            dependencies: ['@whiskeysockets/baileys', 'fs-extra']
        };
        this.commands = [
            {
                name: 'ping',
                description: 'Check bot response time',
                usage: '.ping',
                permissions: 'public',
                ui: {
                    processingText: '🏓 *Pinging...*\n\n⏳ Measuring response time...',
                    errorText: '❌ *Ping Failed*'
                },
                execute: this.ping.bind(this)
            },
            {
                name: 'status',
                description: 'Show bot status and statistics',
                usage: '.status',
                permissions: 'public',
                ui: {
                    processingText: '📊 *Checking Status...*\n\n⏳ Gathering system information...',
                    errorText: '❌ *Status Check Failed*'
                },
                execute: this.status.bind(this)
            },
            {
                name: 'restart',
                description: 'Restart the bot (owner only)',
                usage: '.restart',
                permissions: 'owner',
                ui: {
                    processingText: '🔄 *Restarting Bot...*\n\n⏳ Please wait...',
                    errorText: '❌ *Restart Failed*'
                },
                execute: this.restart.bind(this)
            },
            {
                name: 'sync',
                description: 'Sync contacts from WhatsApp',
                usage: '.sync',
                permissions: 'public',
                ui: {
                    processingText: '📞 *Syncing Contacts...*\n\n⏳ Please wait...',
                    errorText: '❌ *Contact Sync Failed*'
                },
                execute: this.sync.bind(this)
            },
            {
                name: 'mode',
                description: 'Toggle bot mode between public and private',
                usage: '.mode [public|private]',
                permissions: 'owner',
                ui: {
                    processingText: '🌐 *Changing Mode...*\n\n⏳ Updating settings...',
                    errorText: '❌ *Mode Change Failed*'
                },
                execute: this.toggleMode.bind(this)
            },
            {
                name: 'logs',
                description: 'Send or display bot logs (owner only)',
                usage: '.logs [display]',
                permissions: 'owner',
                ui: {
                    processingText: '📜 *Loading Logs...*\n\n⏳ Gathering log files...',
                    errorText: '❌ *Log Loading Failed*'
                },
                execute: this.logs.bind(this)
            },
            {
                name: 'ban',
                description: 'Ban a user from using the bot',
                usage: '.ban <phone_number>',
                permissions: 'owner',
                ui: {
                    processingText: '🚫 *Banning User...*\n\n⏳ Processing ban...',
                    errorText: '❌ *Ban Failed*'
                },
                execute: this.banUser.bind(this)
            },
            {
                name: 'unban',
                description: 'Unban a user',
                usage: '.unban <phone_number>',
                permissions: 'owner',
                ui: {
                    processingText: '✅ *Unbanning User...*\n\n⏳ Processing unban...',
                    errorText: '❌ *Unban Failed*'
                },
                execute: this.unbanUser.bind(this)
            },
            {
                name: 'broadcast',
                description: 'Send a message to all chats',
                usage: '.broadcast <message>',
                permissions: 'owner',
                ui: {
                    processingText: '📢 *Broadcasting Message...*\n\n⏳ Sending to all chats...',
                    errorText: '❌ *Broadcast Failed*'
                },
                execute: this.broadcast.bind(this)
            },
            {
                name: 'clearlogs',
                description: 'Clear bot log files',
                usage: '.clearlogs',
                permissions: 'owner',
                ui: {
                    processingText: '🗑️ *Clearing Logs...*\n\n⏳ Removing log files...',
                    errorText: '❌ *Log Clear Failed*'
                },
                execute: this.clearLogs.bind(this)
            },
            {
                name: 'stats',
                description: 'Show bot usage statistics',
                usage: '.stats',
                permissions: 'public',
                ui: {
                    processingText: '📊 *Gathering Statistics...*\n\n⏳ Calculating usage data...',
                    errorText: '❌ *Stats Loading Failed*'
                },
                execute: this.stats.bind(this)
            }
        ];
        this.startTime = Date.now();
        this.commandCounts = new Map();
    }

    async ping(msg, params, context) {
        const start = Date.now();
        const latency = Date.now() - start;
        this.incrementCommandCount('ping');
        return `🏓 *Pong!*\n\n⚡ Latency: ${latency}ms\n⏰ ${new Date().toLocaleTimeString()}`;
    }

    async status(msg, params, context) {
        const uptime = this.getUptime();
        const totalCommands = Array.from(this.commandCounts.values()).reduce((a, b) => a + b, 0);
        this.incrementCommandCount('status');
        
        return `🤖 *${config.get('bot.name')} Status*\n\n` +
               `🆚 Version: ${config.get('bot.version')}\n` +
               `🏢 Company: ${config.get('bot.company')}\n` +
               `👤 Owner: ${config.get('bot.owner')?.split('@')[0] || 'Not set'}\n` +
               `⏰ Uptime: ${uptime}\n` +
               `📊 Commands Executed: ${totalCommands}\n` +
               `🌐 Mode: ${config.get('features.mode')}\n` +
               `🔗 Telegram Bridge: ${config.get('telegram.enabled') ? 'Enabled' : 'Disabled'}\n` +
               `📞 Contacts Synced: ${this.bot.telegramBridge?.contactMappings.size || 0}`;
    }

    async restart(msg, params, context) {
        if (this.bot.telegramBridge) {
            await this.bot.telegramBridge.logToTelegram('🔄 Bot Restart', 'Initiated by owner');
        }
        this.incrementCommandCount('restart');
        setTimeout(() => process.exit(0), 1000);
        return '🔄 *Bot Restarting...*\n\nPlease wait for reconnection...';
    }

    async sync(msg, params, context) {
        if (!this.bot.telegramBridge) {
            return '❌ Telegram bridge not enabled';
        }
        
        await this.bot.telegramBridge.syncContacts();
        this.incrementCommandCount('sync');
        
        return `✅ *Contact Sync Complete*\n\n📞 Synced ${this.bot.telegramBridge.contactMappings.size} contacts`;
    }

    async toggleMode(msg, params, context) {
        if (params.length === 0) {
            return `🌐 *Current Mode*: ${config.get('features.mode')}\n\nUsage: \`.mode [public|private]\``;
        }

        const mode = params[0].toLowerCase();
        if (mode !== 'public' && mode !== 'private') {
            return '❌ Invalid mode. Use `.mode public` or `.mode private`.';
        }

        config.set('features.mode', mode);
        this.incrementCommandCount('mode');
        
        if (this.bot.telegramBridge) {
            await this.bot.telegramBridge.logToTelegram('🌐 Bot Mode Changed', `New Mode: ${mode}`);
        }
        
        return `✅ *Bot Mode Changed*\n\n🌐 New Mode: ${mode}\n⏰ ${new Date().toLocaleTimeString()}`;
    }

    async logs(msg, params, context) {
        const displayMode = params[0]?.toLowerCase() === 'display';
        if (!config.get('logging.saveToFile') && displayMode) {
            return '❌ Log saving to file is not enabled';
        }

        const logDir = path.join(__dirname, '../logs');
        if (!await fs.pathExists(logDir)) {
            return '❌ No logs found';
        }

        this.incrementCommandCount('logs');

        if (displayMode) {
            try {
                const logFiles = (await fs.readdir(logDir))
                    .filter(file => file.endsWith('.log'))
                    .sort((a, b) => fs.statSync(path.join(logDir, b)).mtime - fs.statSync(path.join(logDir, a)).mtime);
                
                if (logFiles.length === 0) {
                    return '❌ No log files found';
                }

                const latestLogFile = path.join(logDir, logFiles[0]);
                const logContent = await fs.readFile(latestLogFile, 'utf8');
                const logLines = logContent.split('\n').filter(line => line.trim());
                const recentLogs = logLines.slice(-10).join('\n'); // Last 10 lines
                
                if (this.bot.telegramBridge) {
                    await this.bot.telegramBridge.logToTelegram('📜 Logs Displayed', 'Recent logs viewed by owner');
                }
                
                return `📜 *Recent Logs* (Last 10 Entries)\n\n\`\`\`\n${recentLogs || 'No recent logs'}\n\`\`\`\n⏰ ${new Date().toLocaleTimeString()}`;
            } catch (error) {
                throw new Error(`Failed to display logs: ${error.message}`);
            }
        } else {
            try {
                const logFiles = (await fs.readdir(logDir))
                    .filter(file => file.endsWith('.log'))
                    .sort((a, b) => fs.statSync(path.join(logDir, b)).mtime - fs.statSync(path.join(logDir, a)).mtime);
                
                if (logFiles.length === 0) {
                    return '❌ No log files found';
                }

                const latestLogFile = path.join(logDir, logFiles[0]);
                await context.bot.sendMessage(context.sender, {
                    document: { source: latestLogFile, filename: logFiles[0] },
                    caption: `📜 *Latest Log File*\n\n📄 File: ${logFiles[0]}\n⏰ ${new Date().toLocaleTimeString()}`
                });
                
                if (this.bot.telegramBridge) {
                    await this.bot.telegramBridge.logToTelegram('📜 Log File Sent', `File: ${logFiles[0]}`);
                }
                
                return `✅ *Log File Sent*\n\n📄 File: ${logFiles[0]}`;
            } catch (error) {
                throw new Error(`Failed to send log file: ${error.message}`);
            }
        }
    }

    async banUser(msg, params, context) {
        if (params.length === 0) {
            return '❌ Usage: `.ban <phone_number>`';
        }

        const phone = params[0].replace('+', '');
        const blockedUsers = config.get('security.blockedUsers') || [];
        if (blockedUsers.includes(phone)) {
            return `❌ User ${phone} is already banned`;
        }

        blockedUsers.push(phone);
        config.set('security.blockedUsers', blockedUsers);
        this.incrementCommandCount('ban');
        
        if (this.bot.telegramBridge) {
            await this.bot.telegramBridge.logToTelegram('🚫 User Banned', `Phone: ${phone}`);
        }
        
        return `🚫 *User Banned*\n\n📱 Phone: ${phone}\n⏰ ${new Date().toLocaleTimeString()}`;
    }

    async unbanUser(msg, params, context) {
        if (params.length === 0) {
            return '❌ Usage: `.unban <phone_number>`';
        }

        const phone = params[0].replace('+', '');
        const blockedUsers = config.get('security.blockedUsers') || [];
        if (!blockedUsers.includes(phone)) {
            return `❌ User ${phone} is not banned`;
        }

        config.set('security.blockedUsers', blockedUsers.filter(u => u !== phone));
        this.incrementCommandCount('unban');
        
        if (this.bot.telegramBridge) {
            await this.bot.telegramBridge.logToTelegram('✅ User Unbanned', `Phone: ${phone}`);
        }
        
        return `✅ *User Unbanned*\n\n📱 Phone: ${phone}\n⏰ ${new Date().toLocaleTimeString()}`;
    }

    async broadcast(msg, params, context) {
        if (params.length === 0) {
            return '❌ Usage: `.broadcast <message>`';
        }

        const message = params.join(' ');
        const chats = this.bot.telegramBridge?.chatMappings.keys() || [];
        let sentCount = 0;

        for (const chatJid of chats) {
            if (chatJid !== 'status@broadcast' && chatJid !== 'call@broadcast') {
                try {
                    await this.bot.sendMessage(chatJid, { text: `📢 *Broadcast*\n\n${message}` });
                    sentCount++;
                } catch (error) {
                    logger.error(`Failed to send broadcast to ${chatJid}:`, error);
                }
            }
        }

        this.incrementCommandCount('broadcast');
        
        if (this.bot.telegramBridge) {
            await this.bot.telegramBridge.logToTelegram('📢 Broadcast Sent', `Message: ${message}\nSent to ${sentCount} chats`);
        }
        
        return `📢 *Broadcast Sent*\n\n📩 Message: ${message}\n📊 Sent to ${sentCount} chats\n⏰ ${new Date().toLocaleTimeString()}`;
    }

    async clearLogs(msg, params, context) {
        if (!config.get('logging.saveToFile')) {
            return '❌ Log saving to file is not enabled';
        }

        const logDir = path.join(__dirname, '../logs');
        try {
            await fs.emptyDir(logDir);
            this.incrementCommandCount('clearlogs');
            
            if (this.bot.telegramBridge) {
                await this.bot.telegramBridge.logToTelegram('🗑️ Logs Cleared', 'Log files removed');
            }
            
            return `✅ *Logs Cleared*\n\n🗑️ Log files removed\n⏰ ${new Date().toLocaleTimeString()}`;
        } catch (error) {
            throw new Error(`Failed to clear logs: ${error.message}`);
        }
    }

    async stats(msg, params, context) {
        const totalCommands = Array.from(this.commandCounts.values()).reduce((a, b) => a + b, 0);
        const commandBreakdown = Array.from(this.commandCounts.entries())
            .map(([cmd, count]) => `  • \`${cmd}\`: ${count}`)
            .join('\n');
        const messageCount = this.bot.telegramBridge?.userMappings.size || 0;
        
        this.incrementCommandCount('stats');
        
        return `📊 *Bot Statistics*\n\n` +
               `📟 Total Commands: ${totalCommands}\n` +
               `📋 Command Breakdown:\n${commandBreakdown || '  • None'}\n` +
               `💬 Total Users: ${messageCount}\n` +
               `📞 Active Chats: ${this.bot.telegramBridge?.chatMappings.size || 0}\n` +
               `👥 Contacts: ${this.bot.telegramBridge?.contactMappings.size || 0}`;
    }

    getUptime() {
        const seconds = Math.floor((Date.now() - this.startTime) / 1000);
        const days = Math.floor(seconds / (3600 * 24));
        const hours = Math.floor((seconds % (3600 * 24)) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;
        return `${days}d ${hours}h ${minutes}m ${secs}s`;
    }

    incrementCommandCount(command) {
        this.commandCounts.set(command, (this.commandCounts.get(command) || 0) + 1);
    }
}

module.exports = CoreCommands;
