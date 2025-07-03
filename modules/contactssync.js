const { connectDb } = require('../utils/db');
const helpers = require('../utils/helpers');

class ContactSyncModule {
    constructor(bot) {
        this.bot = bot;
        this.name = 'contactsync';
        this.metadata = {
            description: 'Auto and manual WhatsApp contact sync module',
            version: '1.0.0',
            author: 'OpenAI',
            category: 'utility'
        };

        this.commands = [
            {
                name: 'synccontacts',
                description: 'Manually sync WhatsApp contacts',
                usage: '.synccontacts',
                permissions: 'admin',
                ui: {
                    processingText: '📞 *Syncing Contacts...*\n\nPlease wait while contacts are being fetched...',
                    errorText: '❌ *Contact Sync Failed*'
                },
                execute: this.syncCommand.bind(this)
            }
        ];

        this.autoSyncInterval = null;
        this.contactMappings = new Map(); // phone -> name
        this.collection = null;
    }

    async init() {
        this.collection = this.bot.db.collection('contacts');

        // Load saved mappings into memory
        const saved = await this.collection.find().toArray();
        for (const contact of saved) {
            this.contactMappings.set(contact.phone, contact.name);
        }

        // Start periodic sync every 15 minutes
        this.startAutoSync();
        this.bot.logger.info('📞 ContactSyncModule initialized and auto-sync started');
    }

    async destroy() {
        if (this.autoSyncInterval) clearInterval(this.autoSyncInterval);
    }

    startAutoSync() {
        this.autoSyncInterval = setInterval(() => this.syncContacts(), 15 * 60 * 1000);
    }

    async syncCommand(msg, params, context) {
        const result = await this.syncContacts(true);
        return result;
    }

    async syncContacts(manual = false) {
        const sock = this.bot.whatsapp?.sock;
        if (!sock?.user) {
            this.bot.logger.warn('⚠️ WhatsApp not connected, skipping contact sync');
            return manual ? '⚠️ WhatsApp not connected' : null;
        }

        try {
            if (manual) {
                await this.logToTelegram('📞 Manual Contact Sync Requested');
            }

            try {
                await sock.requestSync(['contact']);
                await sock.fetchPrivacySettings();
                await new Promise(res => setTimeout(res, 2000));
            } catch (e) {
                this.bot.logger.warn('⚠️ Failed to request fresh contact sync:', e.message);
            }

            const contacts = sock.store?.contacts || {};
            const entries = Object.entries(contacts);
            this.bot.logger.debug(`🔍 Found ${entries.length} contacts`);

            let newOrUpdated = 0;

            for (const [jid, contact] of entries) {
                if (!jid || jid === 'status@broadcast' || !contact) continue;

                const phone = jid.split('@')[0];
                const name = contact.name || contact.notify || contact.verifiedName || contact.pushName;
                if (!name || name === phone) continue;

                const existing = this.contactMappings.get(phone);
                if (existing !== name) {
                    this.contactMappings.set(phone, name);
                    await this.collection.updateOne(
                        { phone },
                        { $set: { phone, name, updatedAt: new Date() } },
                        { upsert: true }
                    );
                    newOrUpdated++;
                    this.bot.logger.debug(`📞 Synced: ${phone} -> ${name}`);
                }
            }

            const result = `✅ Synced ${newOrUpdated} new/updated contacts\nTotal: ${this.contactMappings.size}`;
            if (manual || newOrUpdated > 0) {
                await this.logToTelegram('✅ Contact Sync Complete', result);
            }

            return result;
        } catch (err) {
            this.bot.logger.error('❌ Contact sync failed:', err);
            await this.logToTelegram('❌ Contact Sync Failed', err.message);
            return `❌ Contact sync error: ${err.message}`;
        }
    }

    async logToTelegram(title, message = '') {
        const chatId = process.env.ADMIN_TELEGRAM_CHAT_ID;
        const text = `*${title}*\n${message}`;
        if (!this.bot.telegram) return;
        try {
            await this.bot.telegram.sendMessage(chatId, text, { parse_mode: 'Markdown' });
        } catch (e) {
            this.bot.logger.warn('⚠️ Failed to send Telegram log:', e.message);
        }
    }
}

module.exports = ContactSyncModule;
