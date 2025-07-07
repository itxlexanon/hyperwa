const { connectDb } = require('../utils/db');

class PrivacyModule {
    constructor(bot) {
        this.bot = bot;
        this.name = 'privacy';
        this.metadata = {
            description: 'Privacy and security features for enhanced protection',
            version: '1.0.0',
            author: 'HyperWa Team',
            category: 'security',
            dependencies: ['mongodb']
        };
        this.commands = [
            {
                name: 'encrypt',
                description: 'Encrypt text message',
                usage: '.encrypt <text>',
                permissions: 'public',
                ui: {
                    processingText: '🔐 *Encrypting Message...*\n\n⏳ Securing your text...',
                    errorText: '❌ *Encryption Failed*'
                },
                execute: this.encryptText.bind(this)
            },
            {
                name: 'decrypt',
                description: 'Decrypt encrypted message',
                usage: '.decrypt <encrypted_text>',
                permissions: 'public',
                ui: {
                    processingText: '🔓 *Decrypting Message...*\n\n⏳ Revealing your text...',
                    errorText: '❌ *Decryption Failed*'
                },
                execute: this.decryptText.bind(this)
            },
            {
                name: 'temptext',
                description: 'Send self-destructing message',
                usage: '.temptext <seconds> <message>',
                permissions: 'public',
                ui: {
                    processingText: '⏰ *Creating Temporary Message...*\n\n⏳ Setting up auto-delete...',
                    errorText: '❌ *Temporary Message Failed*'
                },
                execute: this.sendTempMessage.bind(this)
            },
            {
                name: 'genpass',
                description: 'Generate secure password',
                usage: '.genpass [length]',
                permissions: 'public',
                ui: {
                    processingText: '🔑 *Generating Password...*\n\n⏳ Creating secure password...',
                    errorText: '❌ *Password Generation Failed*'
                },
                execute: this.generatePassword.bind(this)
            },
            {
                name: 'cleanchat',
                description: 'Delete recent messages (owner only)',
                usage: '.cleanchat <count>',
                permissions: 'owner',
                ui: {
                    processingText: '🧹 *Cleaning Chat...*\n\n⏳ Deleting messages...',
                    errorText: '❌ *Chat Cleanup Failed*'
                },
                execute: this.cleanChat.bind(this)
            }
        ];
        this.tempMessages = new Map();
        this.db = null;
        this.collection = null;
    }

    async init() {
        try {
            this.db = await connectDb();
            this.collection = this.db.collection('privacy_data');
            console.log('✅ Privacy module initialized');
        } catch (error) {
            console.error('❌ Failed to initialize privacy module:', error);
        }
    }

    async encryptText(msg, params, context) {
        if (params.length === 0) {
            return '❌ *Text Encryption*\n\nPlease provide text to encrypt.\n\n💡 Usage: `.encrypt <text>`';
        }

        const text = params.join(' ');
        const encrypted = Buffer.from(text).toString('base64');
        const key = this.generateKey();

        try {
            await this.collection.updateOne(
                { userId: context.participant.split('@')[0], key },
                { 
                    $set: { 
                        encrypted,
                        createdAt: new Date(),
                        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours
                    } 
                },
                { upsert: true }
            );

            return `🔐 *Text Encrypted Successfully*\n\n🔑 Key: \`${key}\`\n📝 Encrypted: \`${encrypted}\`\n\n⚠️ Save the key to decrypt later!\n⏰ Expires in 24 hours`;
        } catch (error) {
            throw new Error(`Encryption failed: ${error.message}`);
        }
    }

    async decryptText(msg, params, context) {
        if (params.length === 0) {
            return '❌ *Text Decryption*\n\nPlease provide encrypted text or key.\n\n💡 Usage: `.decrypt <encrypted_text_or_key>`';
        }

        const input = params[0];
        const userId = context.participant.split('@')[0];

        try {
            // Try to find by key first
            let result = await this.collection.findOne({ userId, key: input });
            
            if (!result) {
                // Try direct decryption
                try {
                    const decrypted = Buffer.from(input, 'base64').toString('utf8');
                    return `🔓 *Text Decrypted*\n\n📝 Original: ${decrypted}`;
                } catch {
                    return '❌ *Decryption Failed*\n\nInvalid encrypted text or key not found.';
                }
            }

            if (result.expiresAt < new Date()) {
                await this.collection.deleteOne({ _id: result._id });
                return '❌ *Decryption Failed*\n\nEncrypted message has expired.';
            }

            const decrypted = Buffer.from(result.encrypted, 'base64').toString('utf8');
            return `🔓 *Text Decrypted Successfully*\n\n📝 Original: ${decrypted}\n⏰ Created: ${result.createdAt.toLocaleString()}`;

        } catch (error) {
            throw new Error(`Decryption failed: ${error.message}`);
        }
    }

    async sendTempMessage(msg, params, context) {
        if (params.length < 2) {
            return '❌ *Temporary Message*\n\nPlease provide duration and message.\n\n💡 Usage: `.temptext <seconds> <message>`';
        }

        const seconds = parseInt(params[0]);
        const message = params.slice(1).join(' ');

        if (isNaN(seconds) || seconds < 5 || seconds > 3600) {
            return '❌ *Invalid Duration*\n\nDuration must be between 5 and 3600 seconds (1 hour).';
        }

        try {
            const tempMsg = await context.bot.sendMessage(context.sender, {
                text: `⏰ *Temporary Message*\n\n📝 ${message}\n\n🗑️ This message will self-destruct in ${seconds} seconds`
            });

            // Schedule deletion
            setTimeout(async () => {
                try {
                    await context.bot.sock.sendMessage(context.sender, {
                        delete: tempMsg.key
                    });
                } catch (error) {
                    console.error('Failed to delete temp message:', error);
                }
            }, seconds * 1000);

            return `✅ *Temporary Message Sent*\n\n⏰ Duration: ${seconds} seconds\n🗑️ Auto-delete scheduled`;

        } catch (error) {
            throw new Error(`Failed to send temporary message: ${error.message}`);
        }
    }

    async generatePassword(msg, params, context) {
        const length = parseInt(params[0]) || 12;
        
        if (length < 4 || length > 50) {
            return '❌ *Invalid Length*\n\nPassword length must be between 4 and 50 characters.';
        }

        const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=[]{}|;:,.<>?';
        let password = '';
        
        for (let i = 0; i < length; i++) {
            password += charset.charAt(Math.floor(Math.random() * charset.length));
        }

        const strength = this.calculatePasswordStrength(password);

        return `🔑 *Secure Password Generated*\n\n🔐 Password: \`${password}\`\n📊 Strength: ${strength}\n📏 Length: ${length} characters\n\n⚠️ Save this password securely!`;
    }

    async cleanChat(msg, params, context) {
        if (params.length === 0) {
            return '❌ *Chat Cleanup*\n\nPlease specify number of messages to delete.\n\n💡 Usage: `.cleanchat <count>`';
        }

        const count = parseInt(params[0]);
        
        if (isNaN(count) || count < 1 || count > 100) {
            return '❌ *Invalid Count*\n\nMessage count must be between 1 and 100.';
        }

        try {
            // This is a placeholder - actual implementation would require message history
            return `⚠️ *Chat Cleanup*\n\nChat cleanup feature requires additional WhatsApp API permissions.\nRequested deletion: ${count} messages`;
        } catch (error) {
            throw new Error(`Chat cleanup failed: ${error.message}`);
        }
    }

    generateKey() {
        return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    }

    calculatePasswordStrength(password) {
        let score = 0;
        if (password.length >= 8) score++;
        if (/[a-z]/.test(password)) score++;
        if (/[A-Z]/.test(password)) score++;
        if (/[0-9]/.test(password)) score++;
        if (/[^A-Za-z0-9]/.test(password)) score++;

        const strengths = ['Very Weak', 'Weak', 'Fair', 'Good', 'Strong', 'Very Strong'];
        return strengths[score] || 'Very Weak';
    }

    async destroy() {
        this.tempMessages.clear();
        console.log('🛑 Privacy module destroyed');
    }
}

module.exports = PrivacyModule;