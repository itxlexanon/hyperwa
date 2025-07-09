const logger = require('../Core/logger');

class TelegramCommands {
    constructor(bridge) {
        this.bridge = bridge;
        this.filters = new Set(); // Initialize a Set to store filters
    }

    async handleCommand(msg) {
        const text = msg.text;
        if (!text || !text.startsWith('/')) return;

        const [command, ...args] = text.trim().split(/\s+/);

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
                case '/addfilter': // New command
                    await this.handleAddFilter(msg.chat.id, args);
                    break;
                case '/listfilters': // New command
                    await this.handleListFilters(msg.chat.id);
                    break;
                case '/clearfilters': // New command
                    await this.handleClearFilters(msg.chat.id);
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
        const message = `👋 *Welcome to the WhatsApp-Telegram Bridge Bot!*
        
This bot bridges your WhatsApp messages to Telegram and vice-versa.

Use /menu to see available commands.`;
        await this.bridge.telegramBot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }

    async handleStatus(chatId) {
        const whatsappStatus = this.bridge.whatsappBot.sock && this.bridge.whatsappBot.sock.user ? '✅ Connected' : '❌ Disconnected';
        const telegramStatus = this.bridge.telegramBot ? '✅ Connected' : '❌ Disconnected';
        const mappingsCount = this.bridge.chatMappings.size;
        const message = `📊 *Bridge Status*
        
WhatsApp: ${whatsappStatus}
Telegram: ${telegramStatus}
Active Chats: ${mappingsCount}`;
        await this.bridge.telegramBot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }

    async handleSend(chatId, args) {
        if (args.length < 2) {
            await this.bridge.telegramBot.sendMessage(chatId, `Usage: \`/send <number> <message>\``, { parse_mode: 'Markdown' });
            return;
        }

        const number = args[0];
        const message = args.slice(1).join(' ');

        try {
            const phoneNumber = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;
            await this.bridge.whatsappBot.sock.sendMessage(phoneNumber, { text: message });
            await this.bridge.telegramBot.sendMessage(chatId, `✅ Message sent to ${number}.`);
        } catch (error) {
            logger.error('Error sending message from Telegram to WhatsApp:', error);
            await this.bridge.telegramBot.sendMessage(chatId, `❌ Failed to send message: ${error.message}`, { parse_mode: 'Markdown' });
        }
    }

    async handleSync(chatId) {
        await this.bridge.telegramBot.sendMessage(chatId, '🔄 Syncing WhatsApp contacts...');
        await this.bridge.syncContacts();
        await this.bridge.telegramBot.sendMessage(chatId, '✅ WhatsApp contacts synced!');
    }

    async handleContacts(chatId) {
        const contacts = Array.from(this.bridge.contactMappings.values());
        if (contacts.length === 0) {
            await this.bridge.telegramBot.sendMessage(chatId, 'No WhatsApp contacts synced yet. Use /sync to sync them.');
            return;
        }

        const contactList = contacts.map(contact => {
            const name = contact.name || contact.verifiedName || contact.notify || contact.number;
            return `📱 ${name} (${contact.number})`;
        }).join('\n');

        await this.bridge.telegramBot.sendMessage(chatId, `*Your WhatsApp Contacts:*\n\n${contactList}`, { parse_mode: 'Markdown' });
    }

    async handleSearchContact(chatId, args) {
        if (args.length === 0) {
            await this.bridge.telegramBot.sendMessage(chatId, `Usage: \`/searchcontact <name/phone>\``, { parse_mode: 'Markdown' });
            return;
        }

        const query = args.join(' ').toLowerCase();
        const contacts = Array.from(this.bridge.contactMappings.values());
        const matches = [];

        for (const contact of contacts) {
            const name = (contact.name || contact.verifiedName || contact.notify || '').toLowerCase();
            const number = (contact.number || '').toLowerCase();

            if (name.includes(query) || number.includes(query)) {
                matches.push([contact.number, contact.name || contact.verifiedName || contact.notify]);
            }
        }

        if (matches.length === 0) {
            await this.bridge.telegramBot.sendMessage(
                chatId,
                `Couldn't find any contacts matching "${query}"`,
                { parse_mode: 'Markdown' });
            return;
        }

        const result = matches.map(([phone, name]) => `📱 ${name || 'Unknown'} (+${phone})`).join('\n');
        await this.bridge.telegramBot.sendMessage(chatId, `🔍 *Search Results*\n\n${result}`, { parse_mode: 'Markdown' });
    }

    // New command implementations
    async handleAddFilter(chatId, args) {
        const filterWord = args.join(' ').trim();
        if (!filterWord) {
            await this.bridge.telegramBot.sendMessage(chatId, `Usage: \`/addfilter <word or phrase>\``, { parse_mode: 'Markdown' });
            return;
        }

        if (this.filters.has(filterWord.toLowerCase())) {
            await this.bridge.telegramBot.sendMessage(chatId, `"${filterWord}" is already in the filter list.`);
            return;
        }

        this.filters.add(filterWord.toLowerCase());
        await this.bridge.telegramBot.sendMessage(chatId, `✅ Added "${filterWord}" to filters.`);
        logger.info(`Added filter: "${filterWord}"`);
    }

    async handleListFilters(chatId) {
        if (this.filters.size === 0) {
            await this.bridge.telegramBot.sendMessage(chatId, `No filters currently active. Use \`/addfilter <word or phrase>\` to add one.`);
            return;
        }

        const filterList = Array.from(this.filters).map(filter => `- ${filter}`).join('\n');
        await this.bridge.telegramBot.sendMessage(chatId, `*Current Filters:*\n\n${filterList}`, { parse_mode: 'Markdown' });
    }

    async handleClearFilters(chatId) {
        this.filters.clear();
        await this.bridge.telegramBot.sendMessage(chatId, `✅ All filters cleared.`);
        logger.info('All filters cleared.');
    }


    async handleMenu(chatId) {
        const message = `ℹ️ *Available Commands*\n\n` +
            `/start - Show bot info\n` +
            `/status - Show bridge status\n` +
            `/send <number> <msg> - Send WhatsApp message\n` +
            `/sync - Sync WhatsApp contacts\n` +
            `/searchcontact <name/phone> - Search contacts\n` +
            `/addfilter <word/phrase> - Add a message filter\n` +
            `/listfilters - List current message filters\n` +
            `/clearfilters - Clear all message filters`;
        await this.bridge.telegramBot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }

    async registerBotCommands() {
        try {
            await this.bridge.telegramBot.setMyCommands([
                { command: 'start', description: 'Show bot info' },
                { command: 'status', description: 'Show bridge status' },
                { command: 'send', description: 'Send WhatsApp message' },
                { command: 'sync', description: 'Sync WhatsApp contacts' },
                { command: 'searchcontact', description: 'Search WhatsApp contacts' },
                { command: 'addfilter', description: 'Add a message filter' }, // New
                { command: 'listfilters', description: 'List current message filters' }, // New
                { command: 'clearfilters', description: 'Clear all message filters' } // New
            ]);
            logger.info('✅ Telegram bot commands registered');
        } catch (error) {
            logger.error('❌ Failed to register Telegram bot commands:', error);
        }
    }
}

module.exports = TelegramCommands;
