const logger = require('../Core/logger');

class TelegramCommands {
    constructor(bridge) {
        this.bridge = bridge;
        this.messageFilters = new Set(); // Store filter words/phrases
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
                case '/addfilter':
                    await this.handleAddFilter(msg.chat.id, args);
                    break;
                case '/removefilter':
                    await this.handleRemoveFilter(msg.chat.id, args);
                    break;
                case '/listfilters':
                    await this.handleListFilters(msg.chat.id);
                    break;
                case '/clearfilters':
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
        const statusText = `🤖 *WhatsApp-Telegram Bridge*\n\n` +
            `Status: ${this.bridge.telegramBot ? '✅ Ready' : '⏳ Initializing...'}\n` +
            `Linked Chats: ${this.bridge.chatMappings?.size || 0}\n` +
            `Contacts: ${this.bridge.contactMappings?.size || 0}\n` +
            `Users: ${this.bridge.userMappings?.size || 0}`;
        await this.bridge.telegramBot.sendMessage(chatId, statusText, { parse_mode: 'Markdown' });
    }

    async handleStatus(chatId) {
        const whatsapp = this.bridge.whatsappBot?.sock;
        const userName = whatsapp?.user?.name || 'Unknown';

        const status = `📊 *Bridge Status*\n\n` +
            `🔗 WhatsApp: ${whatsapp ? '✅ Connected' : '❌ Disconnected'}\n` +
            `👤 User: ${userName}\n` +
            `💬 Chats: ${this.bridge.chatMappings?.size || 0}\n` +
            `👥 Users: ${this.bridge.userMappings?.size || 0}\n` +
            `📞 Contacts: ${this.bridge.contactMappings?.size || 0}`;
        await this.bridge.telegramBot.sendMessage(chatId, status, { parse_mode: 'Markdown' });
    }

    async handleSend(chatId, args) {
        if (args.length < 2) {
            return this.bridge.telegramBot.sendMessage(chatId,
                '❌ Usage: /send <number> <message>\nExample: /send 1234567890 Hello!',
                { parse_mode: 'Markdown' });
        }

        const number = args[0].replace(/\D/g, '');
        const message = args.slice(1).join(' ');

        if (!/^\d{6,15}$/.test(number)) {
            return this.bridge.telegramBot.sendMessage(chatId,
                '❌ Invalid phone number format.',
                { parse_mode: 'Markdown' });
        }

        const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;

        try {
            const result = await this.bridge.whatsappBot.sendMessage(jid, { text: message });
            const response = result?.key?.id ? `✅ Message sent to ${number}` : `⚠️ Message sent, but no confirmation`;
            await this.bridge.telegramBot.sendMessage(chatId, response, { parse_mode: 'Markdown' });
        } catch (error) {
            logger.error(`❌ Error sending message to ${number}:`, error);
            await this.bridge.telegramBot.sendMessage(chatId, `❌ Error: ${error.message}`, { parse_mode: 'Markdown' });
        }
    }

    async handleSync(chatId) {
        await this.bridge.telegramBot.sendMessage(chatId, '🔄 Syncing contacts...', { parse_mode: 'Markdown' });
        try {
            await this.bridge.syncContacts();
            await this.bridge.saveMappingsToDb?.();
            await this.bridge.telegramBot.sendMessage(chatId,
                `✅ Synced ${this.bridge.contactMappings.size} contacts from WhatsApp`,
                { parse_mode: 'Markdown' });
        } catch (error) {
            await this.bridge.telegramBot.sendMessage(chatId, `❌ Failed to sync: ${error.message}`, { parse_mode: 'Markdown' });
        }
    }

    async handleContacts(chatId) {
        const contacts = [...this.bridge.contactMappings.entries()];
        if (contacts.length === 0) {
            return this.bridge.telegramBot.sendMessage(chatId,
                '📞 No contacts found. Use /sync to sync WhatsApp contacts.',
                { parse_mode: 'Markdown' });
        }

        const contactList = contacts
            .slice(0, 50)
            .map(([phone, name]) => `📱 ${name || 'Unknown'} (+${phone})`)
            .join('\n');

        const message = `📞 *WhatsApp Contacts (${contacts.length})*\n\n${contactList}` +
            (contacts.length > 50 ? '\n\n... and more. Use /searchcontact to find specific contacts.' : '');

        await this.bridge.telegramBot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }

    async handleSearchContact(chatId, args) {
        if (args.length === 0) {
            return this.bridge.telegramBot.sendMessage(chatId,
                '❌ Usage: /searchcontact <name or phone>\nExample: /searchcontact John',
                { parse_mode: 'Markdown' });
        }

        const query = args.join(' ').toLowerCase();
        const contacts = [...this.bridge.contactMappings.entries()];
        const matches = contacts.filter(([phone, name]) =>
            phone.includes(query) || name?.toLowerCase().includes(query)
        );

        if (matches.length === 0) {
            return this.bridge.telegramBot.sendMessage(chatId,
                `❌ No contacts found for "${query}"`,
                { parse_mode: 'Markdown' });
        }

        const result = matches.map(([phone, name]) => `📱 ${name || 'Unknown'} (+${phone})`).join('\n');
        await this.bridge.telegramBot.sendMessage(chatId, `🔍 *Search Results*\n\n${result}`, { parse_mode: 'Markdown' });
    }

    async handleAddFilter(chatId, args) {
        if (args.length === 0) {
            return this.bridge.telegramBot.sendMessage(chatId,
                '❌ Usage: /addfilter <word or phrase>\nExample: /addfilter !bot\nExample: /addfilter "admin message"',
                { parse_mode: 'Markdown' });
        }

        const filter = args.join(' ').toLowerCase();
        this.messageFilters.add(filter);
        
        // Save to database
        try {
            await this.bridge.saveFiltersToDb();
            await this.bridge.telegramBot.sendMessage(chatId,
                `✅ Filter added: "${filter}"\n\nMessages starting with this will not be sent to WhatsApp.`,
                { parse_mode: 'Markdown' });
        } catch (error) {
            await this.bridge.telegramBot.sendMessage(chatId,
                `❌ Failed to save filter: ${error.message}`,
                { parse_mode: 'Markdown' });
        }
    }

    async handleRemoveFilter(chatId, args) {
        if (args.length === 0) {
            return this.bridge.telegramBot.sendMessage(chatId,
                '❌ Usage: /removefilter <word or phrase>\nExample: /removefilter !bot',
                { parse_mode: 'Markdown' });
        }

        const filter = args.join(' ').toLowerCase();
        
        if (!this.messageFilters.has(filter)) {
            return this.bridge.telegramBot.sendMessage(chatId,
                `❌ Filter "${filter}" not found.\nUse /listfilters to see active filters.`,
                { parse_mode: 'Markdown' });
        }

        this.messageFilters.delete(filter);
        
        try {
            await this.bridge.saveFiltersToDb();
            await this.bridge.telegramBot.sendMessage(chatId,
                `✅ Filter removed: "${filter}"`,
                { parse_mode: 'Markdown' });
        } catch (error) {
            await this.bridge.telegramBot.sendMessage(chatId,
                `❌ Failed to save changes: ${error.message}`,
                { parse_mode: 'Markdown' });
        }
    }

    async handleListFilters(chatId) {
        if (this.messageFilters.size === 0) {
            return this.bridge.telegramBot.sendMessage(chatId,
                '📋 *Message Filters*\n\nNo filters configured.\n\nUse /addfilter to add message filters.',
                { parse_mode: 'Markdown' });
        }

        const filterList = Array.from(this.messageFilters)
            .map((filter, index) => `${index + 1}. "${filter}"`)
            .join('\n');

        await this.bridge.telegramBot.sendMessage(chatId,
            `📋 *Message Filters (${this.messageFilters.size})*\n\n${filterList}\n\n💡 Messages starting with these words/phrases will not be sent to WhatsApp.`,
            { parse_mode: 'Markdown' });
    }

    async handleClearFilters(chatId) {
        if (this.messageFilters.size === 0) {
            return this.bridge.telegramBot.sendMessage(chatId,
                '📋 No filters to clear.',
                { parse_mode: 'Markdown' });
        }

        const count = this.messageFilters.size;
        this.messageFilters.clear();
        
        try {
            await this.bridge.saveFiltersToDb();
            await this.bridge.telegramBot.sendMessage(chatId,
                `✅ Cleared ${count} message filters.`,
                { parse_mode: 'Markdown' });
        } catch (error) {
            await this.bridge.telegramBot.sendMessage(chatId,
                `❌ Failed to save changes: ${error.message}`,
                { parse_mode: 'Markdown' });
        }
    }

    // Check if message should be filtered
    shouldFilterMessage(text) {
        if (!text || this.messageFilters.size === 0) return false;
        
        const lowerText = text.toLowerCase();
        
        for (const filter of this.messageFilters) {
            if (lowerText.startsWith(filter)) {
                return true;
            }
        }
        
        return false;
    }

    async loadFiltersFromDb() {
        try {
            const db = this.bridge.db;
            if (!db) return;
            
            const collection = db.collection('bridge_settings');
            const settings = await collection.findOne({ type: 'message_filters' });
            
            if (settings && settings.filters) {
                this.messageFilters = new Set(settings.filters);
                logger.info(`✅ Loaded ${this.messageFilters.size} message filters`);
            }
        } catch (error) {
            logger.error('❌ Failed to load message filters:', error);
        }
    }

    async handleMenu(chatId) {
        const message = `ℹ️ *Available Commands*\n\n` +
            `/start - Show bot info\n` +
            `/status - Show bridge status\n` +
            `/send <number> <msg> - Send WhatsApp message\n` +
            `/sync - Sync WhatsApp contacts\n` +
            `/searchcontact <name/phone> - Search contacts\n\n` +
            `🔧 *Message Filtering*\n` +
            `/addfilter <word> - Add message filter\n` +
            `/removefilter <word> - Remove message filter\n` +
            `/listfilters - Show all filters\n` +
            `/clearfilters - Clear all filters`;
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
                { command: 'addfilter', description: 'Add message filter' },
                { command: 'removefilter', description: 'Remove message filter' },
                { command: 'listfilters', description: 'List message filters' },
                { command: 'clearfilters', description: 'Clear all filters' }
            ]);
            logger.info('✅ Telegram bot commands registered');
        } catch (error) {
            logger.error('❌ Failed to register Telegram bot commands:', error);
        }
    }
}

module.exports = TelegramCommands;