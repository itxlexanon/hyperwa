const logger = require('../Core/logger');

class TelegramCommands {
    constructor(bridge) {
        this.bridge = bridge;
        this.filters = new Set();
        this.loadFiltersFromDb();
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
                case '/searchcontact':
                    await this.handleSearchContact(msg.chat.id, args);
                    break;
                case '/addfilter':
                    await this.handleAddFilter(msg.chat.id, args);
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

    async handleAddFilter(chatId, args) {
        if (args.length === 0) {
            return this.bridge.telegramBot.sendMessage(chatId,
                '❌ Usage: /addfilter <word>', { parse_mode: 'Markdown' });
        }
        const word = args.join(' ').toLowerCase();
        this.filters.add(word);
        await this.bridge.telegramBot.sendMessage(chatId,
            `✅ Added filter: \`${word}\``, { parse_mode: 'Markdown' });
        await this.saveFiltersToDb();
    }

    async handleListFilters(chatId) {
        if (this.filters.size === 0) {
            return this.bridge.telegramBot.sendMessage(chatId,
                'ℹ️ No filters set.', { parse_mode: 'Markdown' });
        }
        const list = [...this.filters].map((w, i) => `${i + 1}. \`${w}\``).join('\n');
        await this.bridge.telegramBot.sendMessage(chatId,
            `🛡️ *Active Filters:*\n${list}`, { parse_mode: 'Markdown' });
    }

    async handleClearFilters(chatId) {
        this.filters.clear();
        await this.bridge.telegramBot.sendMessage(chatId,
            `✅ All filters cleared.`, { parse_mode: 'Markdown' });
        await this.saveFiltersToDb();
    }

    isBlockedMessage(text) {
        if (!text) return false;
        const lower = text.toLowerCase();
        for (const word of this.filters) {
            if (lower.startsWith(word)) return true;
        }
        return false;
    }

    async loadFiltersFromDb() {
        try {
            const doc = await this.bridge.collection.findOne({ type: 'filters' });
            if (doc?.data?.list?.length) {
                doc.data.list.forEach(word => this.filters.add(word));
                logger.info(`🛡️ Loaded ${this.filters.size} filters from DB`);
            }
        } catch (err) {
            logger.error('❌ Failed to load filters from DB:', err);
        }
    }

    async saveFiltersToDb() {
        try {
            await this.bridge.collection.updateOne(
                { type: 'filters' },
                { $set: { type: 'filters', data: { list: Array.from(this.filters) } } },
                { upsert: true }
            );
        } catch (err) {
            logger.error('❌ Failed to save filters to DB:', err);
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

    async handleMenu(chatId) {
        const message = `ℹ️ *Available Commands*\n\n` +
            `/start - Show bot info\n` +
            `/status - Show bridge status\n` +
            `/send <number> <msg> - Send WhatsApp message\n` +
            `/sync - Sync WhatsApp contacts\n` +
            `/searchcontact <query> - Search contacts\n` +
            `/addfilter <word> - Add word to filter list\n` +
            `/listfilters - View active filters\n` +
            `/clearfilters - Remove all filters`;
        await this.bridge.telegramBot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }
}

module.exports = TelegramCommands;
 
