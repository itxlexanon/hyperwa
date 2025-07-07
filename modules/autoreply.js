const { connectDb } = require('../utils/db');

class AutoReplyModule {
    constructor(bot) {
        this.bot = bot;
        this.name = 'autoreply';
        this.metadata = {
            description: 'Automated reply system with keyword detection',
            version: '1.0.0',
            author: 'HyperWa Team',
            category: 'automation',
            dependencies: ['mongodb']
        };
        this.commands = [
            {
                name: 'addreply',
                description: 'Add auto-reply rule',
                usage: '.addreply <keyword> | <response>',
                permissions: 'admin',
                ui: {
                    processingText: '🤖 *Adding Auto-Reply...*\n\n⏳ Setting up automated response...',
                    errorText: '❌ *Auto-Reply Setup Failed*'
                },
                execute: this.addAutoReply.bind(this)
            },
            {
                name: 'delreply',
                description: 'Delete auto-reply rule',
                usage: '.delreply <keyword>',
                permissions: 'admin',
                ui: {
                    processingText: '🗑️ *Removing Auto-Reply...*\n\n⏳ Deleting rule...',
                    errorText: '❌ *Auto-Reply Deletion Failed*'
                },
                execute: this.deleteAutoReply.bind(this)
            },
            {
                name: 'listreplies',
                description: 'List all auto-reply rules',
                usage: '.listreplies',
                permissions: 'admin',
                ui: {
                    processingText: '📋 *Loading Auto-Replies...*\n\n⏳ Fetching rules...',
                    errorText: '❌ *Failed to Load Auto-Replies*'
                },
                execute: this.listAutoReplies.bind(this)
            },
            {
                name: 'togglereply',
                description: 'Enable/disable auto-reply system',
                usage: '.togglereply [on|off]',
                permissions: 'admin',
                ui: {
                    processingText: '⚙️ *Toggling Auto-Reply...*\n\n⏳ Updating settings...',
                    errorText: '❌ *Toggle Failed*'
                },
                execute: this.toggleAutoReply.bind(this)
            }
        ];
        this.messageHooks = {
            'all': this.processAutoReply.bind(this)
        };
        this.db = null;
        this.collection = null;
        this.isEnabled = true;
        this.autoReplies = new Map();
    }

    async init() {
        try {
            this.db = await connectDb();
            this.collection = this.db.collection('auto_replies');
            await this.loadAutoReplies();
            console.log('✅ Auto-reply module initialized');
        } catch (error) {
            console.error('❌ Failed to initialize auto-reply module:', error);
        }
    }

    async loadAutoReplies() {
        try {
            const replies = await this.collection.find({}).toArray();
            this.autoReplies.clear();
            
            replies.forEach(reply => {
                this.autoReplies.set(reply.keyword.toLowerCase(), {
                    response: reply.response,
                    isActive: reply.isActive !== false,
                    createdAt: reply.createdAt,
                    usageCount: reply.usageCount || 0
                });
            });

            console.log(`📋 Loaded ${this.autoReplies.size} auto-reply rules`);
        } catch (error) {
            console.error('❌ Failed to load auto-replies:', error);
        }
    }

    async addAutoReply(msg, params, context) {
        if (params.length === 0) {
            return '❌ *Auto-Reply Setup*\n\nPlease provide keyword and response.\n\n💡 Usage: `.addreply <keyword> | <response>`\n📝 Example: `.addreply hello | Hello! How can I help you?`';
        }

        const input = params.join(' ');
        const parts = input.split('|').map(part => part.trim());

        if (parts.length !== 2 || !parts[0] || !parts[1]) {
            return '❌ *Invalid Format*\n\nPlease use the format: keyword | response\n\n📝 Example: `.addreply hello | Hello! How can I help you?`';
        }

        const keyword = parts[0].toLowerCase();
        const response = parts[1];

        try {
            await this.collection.updateOne(
                { keyword },
                {
                    $set: {
                        keyword,
                        response,
                        isActive: true,
                        createdAt: new Date(),
                        updatedAt: new Date(),
                        createdBy: context.participant
                    },
                    $setOnInsert: { usageCount: 0 }
                },
                { upsert: true }
            );

            this.autoReplies.set(keyword, {
                response,
                isActive: true,
                createdAt: new Date(),
                usageCount: 0
            });

            return `✅ *Auto-Reply Added*\n\n🔑 Keyword: "${keyword}"\n💬 Response: "${response}"\n⏰ ${new Date().toLocaleTimeString()}`;

        } catch (error) {
            throw new Error(`Failed to add auto-reply: ${error.message}`);
        }
    }

    async deleteAutoReply(msg, params, context) {
        if (params.length === 0) {
            return '❌ *Delete Auto-Reply*\n\nPlease provide a keyword to delete.\n\n💡 Usage: `.delreply <keyword>`';
        }

        const keyword = params.join(' ').toLowerCase();

        if (!this.autoReplies.has(keyword)) {
            return `❌ *Keyword Not Found*\n\nNo auto-reply rule found for "${keyword}".\nUse \`.listreplies\` to see all rules.`;
        }

        try {
            await this.collection.deleteOne({ keyword });
            this.autoReplies.delete(keyword);

            return `✅ *Auto-Reply Deleted*\n\n🔑 Keyword: "${keyword}"\n⏰ ${new Date().toLocaleTimeString()}`;

        } catch (error) {
            throw new Error(`Failed to delete auto-reply: ${error.message}`);
        }
    }

    async listAutoReplies(msg, params, context) {
        if (this.autoReplies.size === 0) {
            return '📋 *Auto-Reply Rules*\n\nNo auto-reply rules configured.\n\n💡 Use `.addreply <keyword> | <response>` to add rules.';
        }

        let replyText = `📋 *Auto-Reply Rules (${this.autoReplies.size})*\n\n`;
        replyText += `🔄 Status: ${this.isEnabled ? 'Enabled' : 'Disabled'}\n\n`;

        let index = 1;
        for (const [keyword, data] of this.autoReplies) {
            const status = data.isActive ? '✅' : '❌';
            const usage = data.usageCount || 0;
            
            replyText += `${index}. ${status} **${keyword}**\n`;
            replyText += `   💬 "${data.response.substring(0, 50)}${data.response.length > 50 ? '...' : ''}"\n`;
            replyText += `   📊 Used ${usage} times\n\n`;
            index++;
        }

        replyText += `💡 Use \`.togglereply\` to enable/disable\n`;
        replyText += `🗑️ Use \`.delreply <keyword>\` to remove rules`;

        return replyText;
    }

    async toggleAutoReply(msg, params, context) {
        const action = params[0]?.toLowerCase();
        
        if (action === 'on') {
            this.isEnabled = true;
        } else if (action === 'off') {
            this.isEnabled = false;
        } else {
            this.isEnabled = !this.isEnabled;
        }

        const status = this.isEnabled ? 'Enabled' : 'Disabled';
        const emoji = this.isEnabled ? '✅' : '❌';

        return `${emoji} *Auto-Reply ${status}*\n\n🔄 Status: ${status}\n📋 Rules: ${this.autoReplies.size}\n⏰ ${new Date().toLocaleTimeString()}`;
    }

    async processAutoReply(msg, text) {
        if (!this.isEnabled || !text || text.startsWith('.') || msg.key.fromMe) {
            return; // Skip if disabled, no text, is command, or from self
        }

        const messageText = text.toLowerCase();
        
        for (const [keyword, data] of this.autoReplies) {
            if (data.isActive && messageText.includes(keyword)) {
                try {
                    // Send auto-reply
                    await this.bot.sendMessage(msg.key.remoteJid, {
                        text: data.response
                    });

                    // Update usage count
                    await this.collection.updateOne(
                        { keyword },
                        { 
                            $inc: { usageCount: 1 },
                            $set: { lastUsed: new Date() }
                        }
                    );

                    // Update local cache
                    data.usageCount = (data.usageCount || 0) + 1;

                    console.log(`🤖 Auto-reply triggered: "${keyword}" -> "${data.response}"`);
                    break; // Only trigger first matching rule
                } catch (error) {
                    console.error('❌ Auto-reply failed:', error);
                }
            }
        }
    }

    async destroy() {
        this.autoReplies.clear();
        console.log('🛑 Auto-reply module destroyed');
    }
}

module.exports = AutoReplyModule;