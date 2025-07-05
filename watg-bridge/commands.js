const logger = require('../Core/logger');

class TelegramCommands {
    constructor(bridge) {
        this.bridge = bridge;
    }

    async handleCommand(msg) {
        const text = msg.text;
        if (!text || !text.startsWith('/')) return;

        const [command, ...args] = text.split(' ');

        try {
            switch (command.toLowerCase()) {
                case '/start':
                    await this.handleStart(msg.chat.id);
                    break;
                case '/status':
                    await this.handleStatus(msg.chat.id);
                    break;
                case '/send':
                    await this.handleSend(msg.chat.id, args);
                    break;
                case '/sync':
                    await this.handleSync(msg.chat.id);
                    break;
                case '/contacts':
                    await this.handleContacts(msg.chat.id);
                    break;
                case '/searchcontact':
                    await this.handleSearchContact(msg.chat.id, args);
                    break;
                case '/updatetopics':
                    await this.handleUpdateTopics(msg.chat.id);
                    break;
                default:
                    await this.handleMenu(msg.chat.id);
            }
        } catch (error) {
            logger.error(`❌ Error handling command ${command}:`, error);
            await this.bridge.telegramBot.sendMessage(
                msg.chat.id,
                `❌ Command error: ${error.message}`,
                { parse_mode: 'Markdown' }
            );
        }
    }

    async handleStart(chatId) {
        const isReady = !!this.bridge.telegramBot;
        const welcome = `🤖 *WhatsApp-Telegram Bridge*\n\n` +
            `Status: ${isReady ? '✅ Ready' : '⏳ Initializing...'}\n` +
            `Linked Chats: ${this.bridge.chatMappings.size}\n` +
            `Contacts: ${this.bridge.contactMappings.size}\n` +
            `Users: ${this.bridge.userMappings.size}\n` +
            `Profile Pics: ${this.bridge.profilePicCache.size}`;
        await this.bridge.telegramBot.sendMessage(chatId, welcome, { parse_mode: 'Markdown' });
    }

    async handleStatus(chatId) {
        const status = `📊 *Bridge Status*\n\n` +
            `🔗 WhatsApp: ${this.bridge.whatsappBot?.sock ? '✅ Connected' : '❌ Disconnected'}\n` +
            `👤 User: ${this.bridge.whatsappBot?.sock?.user?.name || 'Unknown'}\n` +
            `💬 Chats: ${this.bridge.chatMappings.size}\n` +
            `👥 Users: ${this.bridge.userMappings.size}\n` +
            `📞 Contacts: ${this.bridge.contactMappings.size}\n` +
            `📸 Profile Pics: ${this.bridge.profilePicCache.size}`;
        await this.bridge.telegramBot.sendMessage(chatId, status, { parse_mode: 'Markdown' });
    }

    async handleSend(chatId, args) {
        if (args.length < 2) {
            await this.bridge.telegramBot.sendMessage(chatId,
                '❌ Usage: /send <number> <message>\nExample: /send 1234567890 Hello!',
                { parse_mode: 'Markdown' });
            return;
        }

        const number = args[0];
        const message = args.slice(1).join(' ');

        try {
            const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;
            const result = await this.bridge.whatsappBot.sendMessage(jid, { text: message });
            await this.bridge.telegramBot.sendMessage(chatId,
                result?.key?.id ? `✅ Message sent to ${number}` : `⚠️ Message sent but no confirmation`,
                { parse_mode: 'Markdown' });
        } catch (error) {
            await this.bridge.telegramBot.sendMessage(chatId, `❌ Error sending: ${error.message}`, { parse_mode: 'Markdown' });
        }
    }

    async handleSync(chatId) {
        await this.bridge.telegramBot.sendMessage(chatId, '🔄 Syncing contacts...', { parse_mode: 'Markdown' });
        try {
            await this.bridge.syncContacts();
            await this.bridge.telegramBot.sendMessage(chatId,
                `✅ Synced ${this.bridge.contactMappings.size} contacts from WhatsApp`,
                { parse_mode: 'Markdown' });
        } catch (error) {
            await this.bridge.telegramBot.sendMessage(chatId, `❌ Failed to sync: ${error.message}`, { parse_mode: 'Markdown' });
        }
    }

    async handleContacts(chatId) {
        try {
            const contacts = [...this.bridge.contactMappings.entries()];
            if (contacts.length === 0) {
                await this.bridge.telegramBot.sendMessage(chatId, '📞 No contacts found', { parse_mode: 'Markdown' });
                return;
            }
            
            // Paginate contacts (show first 50)
            const contactsToShow = contacts.slice(0, 50);
            const contactList = contactsToShow.map(([phone, name]) => `📱 ${name || 'Unknown'} (+${phone})`).join('\n');
            
            let message = `📞 *Contacts* (${contacts.length} total)\n\n${contactList}`;
            if (contacts.length > 50) {
                message += `\n\n... and ${contacts.length - 50} more contacts`;
            }
            
            await this.bridge.telegramBot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        } catch (error) {
            logger.error('❌ Failed to list contacts:', error);
            await this.bridge.telegramBot.sendMessage(chatId, `❌ Error: ${error.message}`, { parse_mode: 'Markdown' });
        }
    }

    async handleSearchContact(chatId, args) {
        if (args.length < 1) {
            await this.bridge.telegramBot.sendMessage(chatId,
                '❌ Usage: /searchcontact <name or phone>\nExample: /searchcontact John',
                { parse_mode: 'Markdown' });
            return;
        }

        const query = args.join(' ').toLowerCase();
        try {
            const contacts = [...this.bridge.contactMappings.entries()];
            const matches = contacts.filter(([phone, name]) =>
                name?.toLowerCase().includes(query) || phone.includes(query)
            );

            if (matches.length === 0) {
                await this.bridge.telegramBot.sendMessage(chatId, `❌ No contacts found for "${query}"`, { parse_mode: 'Markdown' });
                return;
            }

            const result = matches.map(([phone, name]) => `📱 ${name || 'Unknown'} (+${phone})`).join('\n');
            await this.bridge.telegramBot.sendMessage(chatId, `🔍 *Search Results*\n\n${result}`, { parse_mode: 'Markdown' });
        } catch (error) {
            logger.error('❌ Failed to search contacts:', error);
            await this.bridge.telegramBot.sendMessage(chatId, `❌ Error: ${error.message}`, { parse_mode: 'Markdown' });
        }
    }

    async handleUpdateTopics(chatId) {
        try {
            await this.bridge.telegramBot.sendMessage(chatId, '🔄 Updating topic names...', { parse_mode: 'Markdown' });
            
            const startTime = Date.now();
            const result = await this.bridge.updateTopicNames();
            const endTime = Date.now();
            const duration = ((endTime - startTime) / 1000).toFixed(2);
            
            await this.bridge.telegramBot.sendMessage(chatId, 
                `✅ Topic update complete!\n\n` +
                `📊 Updated: ${result.updated} topics\n` +
                `❌ Failed/Removed: ${result.failed} topics\n` +
                `⏱️ Completed in ${duration} seconds`, 
                { 
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '🔄 Update Again', callback_data: 'update_topics' },
                            { text: '📊 Show Status', callback_data: 'show_status' }
                        ]]
                    }
                }
            );
        } catch (error) {
            logger.error('❌ Failed to update topics:', error);
            await this.bridge.telegramBot.sendMessage(chatId, 
                `❌ Failed to update topic names: ${error.message}`, 
                { parse_mode: 'Markdown' }
            );
        }
    }

    async handleMenu(chatId) {
        const message = `ℹ️ *Available Commands*\n\n` +
            `/start - Show bot info\n` +
            `/status - Show bridge status\n` +
            `/send <number> <msg> - Send WhatsApp message\n` +
            `/sync - Sync WhatsApp contacts\n` +
            `/contacts - View WhatsApp contacts\n` +
            `/searchcontact <name/phone> - Search contacts\n` +
            `/updatetopics - Update all topic names`;
        
        await this.bridge.telegramBot.sendMessage(chatId, message, { 
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '📊 Status', callback_data: 'show_status' },
                        { text: '🔄 Sync Contacts', callback_data: 'sync_contacts' }
                    ],
                    [
                        { text: '📝 Update Topics', callback_data: 'update_topics' },
                        { text: '📞 Show Contacts', callback_data: 'show_contacts' }
                    ]
                ]
            }
        });
    }

    async registerBotCommands() {
        try {
            await this.bridge.telegramBot.setMyCommands([
                { command: 'start', description: 'Show bot info' },
                { command: 'status', description: 'Show bridge status' },
                { command: 'send', description: 'Send WhatsApp message' },
                { command: 'sync', description: 'Sync WhatsApp contacts' },
                { command: 'contacts', description: 'View WhatsApp contacts' },
                { command: 'searchcontact', description: 'Search WhatsApp contacts' },
                { command: 'updatetopics', description: 'Update all topic names' }
            ]);

            // Handle callback queries for inline buttons
            this.bridge.telegramBot.on('callback_query', async (callbackQuery) => {
                const chatId = callbackQuery.message.chat.id;
                const data = callbackQuery.data;

                try {
                    await this.bridge.telegramBot.answerCallbackQuery(callbackQuery.id);

                    switch (data) {
                        case 'show_status':
                            await this.handleStatus(chatId);
                            break;
                        case 'sync_contacts':
                            await this.handleSync(chatId);
                            break;
                        case 'update_topics':
                            await this.handleUpdateTopics(chatId);
                            break;
                        case 'show_contacts':
                            await this.handleContacts(chatId);
                            break;
                        default:
                            await this.bridge.telegramBot.sendMessage(chatId, '❌ Unknown action', { parse_mode: 'Markdown' });
                    }
                } catch (error) {
                    logger.error('❌ Error handling callback query:', error);
                    await this.bridge.telegramBot.sendMessage(chatId, `❌ Error: ${error.message}`, { parse_mode: 'Markdown' });
                }
            });

            logger.info('✅ Telegram bot commands registered');
        } catch (error) {
            logger.error('❌ Failed to register Telegram bot commands:', error);
        }
    }
}

module.exports = TelegramCommands;
