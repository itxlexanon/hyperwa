// modules/contactsync.js
const fs = require('fs');
const path = require('path');

class ContactSyncModule {
    constructor(client, logger) {
        this.client = client;
        this.logger = logger;
    }

    name = 'ContactSync';
    description = 'Sync and view all WhatsApp contacts.';
    command = ['.synccontacts', '.listcontacts'];
    cooldown = 10;

    async fetchAllContacts() {
        const store = this.client?.store;

        if (!store) {
            throw new Error("❌ WhatsApp store not available.");
        }

        const contacts = Object.values(store.contacts || {});
        return contacts.filter(c => c.id && !c.id.endsWith('@g.us')); // Exclude groups
    }

    async waitForStoreReady(retries = 5) {
        while (retries-- > 0) {
            if (this.client?.store) return;
            await new Promise(res => setTimeout(res, 1000));
        }
        throw new Error("❌ WhatsApp store still not available after retries.");
    }

    async syncContactsCommand(message) {
        try {
            await this.waitForStoreReady();
            const contacts = await this.fetchAllContacts();

            const savePath = path.join(__dirname, '..', 'storage', 'contacts.json');
            fs.writeFileSync(savePath, JSON.stringify(contacts, null, 2));

            await message.reply(`✅ Synced ${contacts.length} contacts and saved to *contacts.json*`);
        } catch (error) {
            this.logger.error('Error syncing contacts:', error);
            await message.reply(`❌ Error syncing contacts: ${error.message}`);
        }
    }

    async listContactsCommand(message) {
        try {
            await this.waitForStoreReady();
            const contacts = await this.fetchAllContacts();

            const formatted = contacts
                .map(c => `• ${c.name || c.notify || c.id}`)
                .slice(0, 50) // Limit to first 50 contacts
                .join('\n');

            await message.reply(`📒 First 50 Contacts:\n\n${formatted}`);
        } catch (error) {
            this.logger.error('Error listing contacts:', error);
            await message.reply(`❌ Error listing contacts: ${error.message}`);
        }
    }

    async syncContacts(message) {
        return this.syncContactsCommand(message);
    }

    async handle({ message, args, command }) {
        if (command === '.synccontacts') {
            await this.syncContactsCommand(message);
        } else if (command === '.listcontacts') {
            await this.listContactsCommand(message);
        }
    }
}

module.exports = ContactSyncModule;
