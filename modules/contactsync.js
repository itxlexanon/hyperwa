const { connectDb } = require('../utils/db');
const helpers = require('../utils/helpers');


class ContactSyncModule {
    constructor(bot) {
        this.bot = bot;
        this.name = 'contactssync';
        this.metadata = {
            description: 'Auto and manual WhatsApp contact sync module',
            version: '1.0.0',
            author: 'You',
            category: 'utility',
            dependencies: ['mongodb']
        };
        this.commands = [
            {
                name: 'synccontacts',
                description: 'Manually sync contacts from WhatsApp',
                usage: '.synccontacts',
                permissions: 'private',
                ui: {
                    processingText: '🔄 *Syncing Contacts...*\n\n⏳ Please wait...',
                    errorText: '❌ *Contact Sync Failed*'
                },
                execute: this.syncContactsCommand.bind(this)
            }
        ];
        this.db = null;
        this.collection = null;
        this.syncInterval = null;
    }

    async init() {
        try {
            this.db = await connectDb();
            this.collection = this.db.collection('contacts');
            await this.collection.createIndex({ id: 1 }, { unique: true });

            this.syncInterval = setInterval(() => this.syncContacts(), 30 * 60 * 1000); // every 30 minutes
            console.log('✅ ContactSync module initialized and auto-sync started');
        } catch (error) {
            console.error('❌ Failed to initialize ContactSync module:', error);
        }
    }

    async syncContactsCommand(msg, params, context) {
        const count = await this.syncContacts();
        return `✅ *Contact Sync Complete*\n\n👥 Synced ${count} contact(s) successfully.`;
    }

    async syncContacts() {
        try {
            const contacts = await this.fetchAllContacts();
            let count = 0;

            for (const contact of contacts) {
                if (!contact.id) continue;

                await this.collection.updateOne(
                    { id: contact.id },
                    { $set: { ...contact, updatedAt: new Date() } },
                    { upsert: true }
                );

                count++;
            }

            console.log(`✅ Synced ${count} contacts.`);
            return count;
        } catch (error) {
            console.error('❌ Error syncing contacts:', error);
            return 0;
        }
    }

    async fetchAllContacts() {
        const store = this.bot?.sock?.store;
        if (!store || !store.contacts) {
            throw new Error('❌ WhatsApp store not available.');
        }

        return Object.entries(store.contacts).map(([id, contact]) => ({
            id,
            name: contact.name || contact.notify || '',
            verifiedName: contact.verifiedName || '',
            isBusiness: !!contact.biz,
            isMe: !!contact.isMe
        }));
    }

    async destroy() {
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
        }
        console.log('🗑️ ContactSync module destroyed');
    }
}

module.exports = ContactSyncModule;
