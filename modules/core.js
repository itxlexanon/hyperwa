
const config = require('../config');
const fs = require('fs-extra');
const path = require('path');
const helpers = require('../utils/helpers');

class CoreCommands {
    constructor(bot) {
        this.bot = bot;
        this.name = 'core';
        this.metadata = {
            description: 'Core commands for bot management and system information',
            version: '2.0.1',
            author: 'Grok',
            category: 'system',
            dependencies: ['@whiskeysockets/baileys', 'fs-extra']
        };
        this.commands = [
            {
                name: 'ping',
                description: 'Check bot response time',
                usage: '.ping',
                permissions: 'public',
                execute: this.ping.bind(this)
            },
            {
                name: 'status',
                description: 'Show bot status and statistics',
                usage: '.status',
                permissions: 'public',
                execute: this.status.bind(this)
            },
            {
                name: 'restart',
                description: 'Restart the bot (owner only)',
                usage: '.restart',
                permissions: 'owner',
                execute: this.restart.bind(this)
            },
            {
                name: 'sync',
                description: 'Sync contacts from WhatsApp',
                usage: '.sync',
                permissions: 'public',
                execute: this.sync.bind(this)
            },
            {
                name: 'mode',
                description: 'Toggle bot mode between public and private',
                usage: '.mode [public|private]',
                permissions: 'owner',
                execute: this.toggleMode.bind(this)
            },
            {
                name: 'logs',
                description: 'Send or display bot logs (owner only)',
                usage: '.logs [display]',
                permissions: 'owner',
                execute: this.logs.bind(this)
            },
            {
                name: 'ban',
                description: 'Ban a user from using the bot',
                usage: '.ban <phone_number>',
                permissions: 'owner',
                execute: this.banUser.bind(this)
            },
            {
                name: 'unban',
                description: 'Unban a user',
                usage: '.unban <phone_number>',
                permissions: 'owner',
                execute: this.unbanUser.bind(this)
            },
            {
                name: 'broadcast',
                description: 'Send a message to all chats',
                usage: '.broadcast <message>',
                permissions: 'owner',
                execute: this.broadcast.bind(this)
            },
            {
                name: 'clearlogs',
                description: 'Clear bot log files',
                usage: '.clearlogs',
                permissions: 'owner',
                execute: this.clearLogs.bind(this)
            },
            {
                name: 'stats',
                description: 'Show bot usage statistics',
                usage: '.stats',
                permissions: 'public',
                execute: this.stats.bind(this)
            }
        ];
        this.startTime = Date.now();
        this.commandCounts = new Map();
    }

    async ping(msg, params, context) {
        const start = Date.now();
        const response = await context.bot.sendMessage(context.sender, { text: '🏓 Pinging...' });
        const latency = Date.now() - start;
        await context.bot.sock.sendMessage(context.sender, {
            text: `🏓 *Pong!*\n\nLatency: ${latency}ms\n⏰ ${new Date().toLocaleTimeString()}`,
            edit: response.key
        });
        this.incrementCommandCount('ping');
    }

    async status(msg, params, context) {
        const uptime = this.getUptime();
        const totalCommands = Array.from(this.commandCounts.values()).reduce((a, b) => a + b, 0);
        const statusText = `🤖 *${config.get('bot.name')} Status*\n\n` +
                          `🆚 Version: ${config.get('bot.version')}\n` +
                          `👤 Owner: ${config.get('bot.owner').split('@')[0]}\n` +
                          `⏰ Uptime: ${uptime}\n` +
                          `📊 Commands Executed: ${totalCommands}\n` +
                          `🌐 Mode: ${config.get('features.mode')}\n` +
                          `🔗 Telegram Bridge: ${config.get('telegram.enabled') ? 'Enabled' : 'Disabled'}\n` +
                          `📞 Contacts Synced: ${this.bot.telegramBridge?.contactMappings.size || 0}`;
        await context.bot.sendMessage(context.sender, { text: statusText });
        this.incrementCommandCount('status');
    }

    async restart(msg, params, context) {
        await context.bot.sendMessage(context.sender, { text: '🔄 *Restarting Bot...*\n\n⏳ Please wait...' });
        if (this.bot.telegramBridge) {
            await this.bot.telegramBridge.logToTelegram('🔄 Bot Restart', 'Initiated by owner');
        }
        setTimeout(() => process.exit(0), 1000); // Assuming PM2 or similar restarts the process
        this.incrementCommandCount('restart');
    }

    async sync(msg, params, context) {
        if (!this.bot.telegramBridge) {
            await context.bot.sendMessage(context.sender, { text: '❌ Telegram bridge not enabled' });
            return;
        }
        await context.bot.sendMessage(context.sender, { text: '📞 *Syncing Contacts...*\n\n⏳ Please wait...' });
        await this.bot.telegramBridge.syncContacts();
        await context.bot.sendMessage(context.sender, {
            text: `✅ *Contact Sync Complete*\n\n📞 Synced ${this.bot.telegramBridge.contactMappings.size} contacts`
        });
        this.incrementCommandCount('sync');
    }

    async toggleMode(msg, params, context) {
        if (params.length === 0) {
            await context.bot.sendMessage(context.sender, {
                text: `🌐 *Current Mode*: ${config.get('features.mode')}\n\nUsage: \`.mode [public|private]\``
            });
            return;
        }

        const mode = params[0].toLowerCase();
        if (mode !== 'public' && mode !== 'private') {
            await context.bot.sendMessage(context.sender, { text: '❌ Invalid mode. Use `.mode public` or `.mode private`.' });
            return;
        }

        config.set('features.mode', mode);
        const modeText = `✅ *Bot Mode Changed*\n\n🌐 New Mode: ${mode}\n⏰ ${new Date().toLocaleTimeString()}`;
        await context.bot.sendMessage(context.sender, { text: modeText });
        if (this.bot.telegramBridge) {
            await this.bot.telegramBridge.logToTelegram('🌐 Bot Mode Changed', `New Mode: ${mode}`);
        }
        this.incrementCommandCount('mode');
    }

    async logs(msg, params, context) {
        const displayMode = params[0]?.toLowerCase() === 'display';
        if (!config.get('logging.saveToFile') && displayMode) {
            await context.bot.sendMessage(context.sender, { text: '❌ Log saving to file is not enabled' });
            return;
        }

        const logDir = path.join(__dirname, '../logs');
        if (!await fs.pathExists(logDir)) {
            await context.bot.sendMessage(context.sender, { text: '❌ No logs found' });
            return;
        }

        if (displayMode) {
            try {
                const logFiles = (await fs.readdir(logDir))
                    .filter(file => file.endsWith('.log'))
                    .sort((a, b) => fs.statSync(path.join(logDir, b)).mtime - fs.statSync(path.join(logDir, a)).mtime);
                
                if (logFiles.length === 0) {
                    await context.bot.sendMessage(context.sender, { text: '❌ No log files found' });
                    return;
                }

                const latestLogFile = path.join(logDir, logFiles[0]);
                const logContent = await fs.readFile(latestLogFile, 'utf8');
                const logLines = logContent.split('\n').filter(line => line.trim());
                const recentLogs = logLines.slice(-10).join('\n'); // Last 10 lines
                const logText = `📜 *Recent Logs* (Last 10 Entries)\n\n\`\`\`\n${recentLogs || 'No recent logs'}\n\`\`\`\n⏰ ${new Date().toLocaleTimeString()}`;
                
                await context.bot.sendMessage(context.sender, { text: logText });
                if (this.bot.telegramBridge) {
                    await this.bot.telegramBridge.logToTelegram('📜 Logs Displayed', 'Recent logs viewed by owner');
                }
            } catch (error) {
                this.bot.logger.error('Failed to display logs:', error);
                await context.bot.sendMessage(context.sender, { text: `❌ Failed to display logs: ${error.message}` });
            }
        } else {
            try {
                const logFiles = (await fs.readdir(logDir))
                    .filter(file => file.endsWith('.log'))
                    .sort((a, b) => fs.statSync(path.join(logDir, b)).mtime - fs.statSync(path.join(logDir, a)).mtime);
                
                if (logFiles.length === 0) {
                    await context.bot.sendMessage(context.sender, { text: '❌ No log files found' });
                    return;
                }

                const latestLogFile = path.join(logDir, logFiles[0]);
                await context.bot.sendMessage(context.sender, {
                    document: { source: latestLogFile, filename: logFiles[0] },
                    caption: `📜 *Latest Log File*\n\n📄 File: ${logFiles[0]}\n⏰ ${new Date().toLocaleTimeString()}`
                });
                if (this.bot.telegramBridge) {
                    await this.bot.telegramBridge.logToTelegram('📜 Log File Sent', `File: ${logFiles[0]}`);
                }
            } catch (error) {
                this.bot.logger.error('Failed to send log file:', error);
                await context.bot.sendMessage(context.sender, { text: `❌ Failed to send log file: ${error.message}` });
            }
        }
        this.incrementCommandCount('logs');
    }

    async banUser(msg, params, context) {
        if (params.length === 0) {
            await context.bot.sendMessage(context.sender, { text: '❌ Usage: `.ban <phone_number>`' });
            return;
        }

        const phone = params[0].replace('+', '');
        const blockedUsers = config.get('security.blockedUsers') || [];
        if (blockedUsers.includes(phone)) {
            await context.bot.sendMessage(context.sender, { text: `❌ User ${phone} is already banned` });
            return;
        }

        blockedUsers.push(phone);
        config.set('security.blockedUsers', blockedUsers);
        const banText = `🚫 *User Banned*\n\n📱 Phone: ${phone}\n⏰ ${new Date().toLocaleTimeString()}`;
        await context.bot.sendMessage(context.sender, { text: banText });
        if (this.bot.telegramBridge) {
            await this.bot.telegramBridge.logToTelegram('🚫 User Banned', `Phone: ${phone}`);
        }
        this.incrementCommandCount('ban');
    }

    async unbanUser(msg, params, context) {
        if (params.length === 0) {
            await context.bot.sendMessage(context.sender, { text: '❌ Usage: `.unban <phone_number>`' });
            return;
        }

        const phone = params[0].replace('+', '');
        const blockedUsers = config.get('security.blockedUsers') || [];
        if (!blockedUsers.includes(phone)) {
            await context.bot.sendMessage(context.sender, { text: `❌ User ${phone} is not banned` });
            return;
        }

        config.set('security.blockedUsers', blockedUsers.filter(u => u !== phone));
        const unbanText = `✅ *User Unbanned*\n\n📱 Phone: ${phone}\n⏰ ${new Date().toLocaleTimeString()}`;
        await context.bot.sendMessage(context.sender, { text: unbanText });
        if (this.bot.telegramBridge) {
            await this.bot.telegramBridge.logToTelegram('✅ User Unbanned', `Phone: ${phone}`);
        }
        this.incrementCommandCount('unban');
    }

    async broadcast(msg, params, context) {
        if (params.length === 0) {
            await context.bot.sendMessage(context.sender, { text: '❌ Usage: `.broadcast <message>`' });
            return;
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
                    this.bot.logger.error(`Failed to send broadcast to ${chatJid}:`, error);
                }
            }
        }

        const broadcastText = `📢 *Broadcast Sent*\n\n📩 Message: ${message}\n📊 Sent to ${sentCount} chats\n⏰ ${new Date().toLocaleTimeString()}`;
        await context.bot.sendMessage(context.sender, { text: broadcastText });
        if (this.bot.telegramBridge) {
            await this.bot.telegramBridge.logToTelegram('📢 Broadcast Sent', `Message: ${message}\nSent to ${sentCount} chats`);
        }
        this.incrementCommandCount('broadcast');
    }

    async clearLogs(msg, params, context) {
        if (!config.get('logging.saveToFile')) {
            await context.bot.sendMessage(context.sender, { text: '❌ Log saving to file is not enabled' });
            return;
        }

        const logDir = path.join(__dirname, '../logs');
        try {
            await fs.emptyDir(logDir);
            await context.bot.sendMessage(context.sender, {
                text: `✅ *Logs Cleared*\n\n🗑️ Log files removed\n⏰ ${new Date().toLocaleTimeString()}`
            });
            if (this.bot.telegramBridge) {
                await this.bot.telegramBridge.logToTelegram('🗑️ Logs Cleared', 'Log files removed');
            }
        } catch (error) {
            this.bot.logger.error('Failed to clear logs:', error);
            await context.bot.sendMessage(context.sender, { text: `❌ Failed to clear logs: ${error.message}` });
        }
        this.incrementCommandCount('clearlogs');
    }

    async stats(msg, params, context) {
        const totalCommands = Array.from(this.commandCounts.values()).reduce((a, b) => a + b, 0);
        const commandBreakdown = Array.from(this.commandCounts.entries())
            .map(([cmd, count]) => `  • \`${cmd}\`: ${count}`)
            .join('\n');
        const messageCount = this.bot.telegramBridge?.userMappings.entries()
            .reduce((sum, [_, user]) => sum + (user.messageCount || 0), 0) || 0;
        const statsText = `📊 *Bot Statistics*\n\n` +
                          `📟 Total Commands: ${totalCommands}\n` +
                          `📋 Command Breakdown:\n${commandBreakdown || '  • None'}\n` +
                          `💬 Total Messages: ${messageCount}\n` +
                          `📞 Active Chats: ${this.bot.telegramBridge?.chatMappings.size || 0}\n` +
                          `👥 Contacts: ${this.bot.telegramBridge?.contactMappings.size || 0}`;
        await context.bot.sendMessage(context.sender, { text: statsText });
        this.incrementCommandCount('stats');
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
