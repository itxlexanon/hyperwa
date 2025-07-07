const fs = require('fs-extra');
const path = require('path');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const { Sticker, StickerTypes } = require('wa-sticker-formatter');

class StickerModule {
    constructor(bot) {
        this.bot = bot;
        this.name = 'sticker';
        this.metadata = {
            description: 'Create and manage stickers from images, videos, and text',
            version: '1.0.0',
            author: 'HyperWa Team',
            category: 'media',
            dependencies: ['wa-sticker-formatter', '@whiskeysockets/baileys']
        };
        this.commands = [
            {
                name: 'sticker',
                description: 'Create sticker from image/video',
                usage: '.sticker (reply to image/video)',
                permissions: 'public',
                ui: {
                    processingText: '🎨 *Creating Sticker...*\n\n⏳ Converting to sticker format...',
                    errorText: '❌ *Sticker Creation Failed*'
                },
                execute: this.createSticker.bind(this)
            },
            {
                name: 's',
                description: 'Quick sticker creation (alias)',
                usage: '.s (reply to image/video)',
                permissions: 'public',
                ui: {
                    processingText: '🎨 *Creating Sticker...*\n\n⏳ Converting to sticker format...',
                    errorText: '❌ *Sticker Creation Failed*'
                },
                execute: this.createSticker.bind(this)
            },
            {
                name: 'textsticker',
                description: 'Create sticker from text',
                usage: '.textsticker <text>',
                permissions: 'public',
                ui: {
                    processingText: '📝 *Creating Text Sticker...*\n\n⏳ Generating sticker from text...',
                    errorText: '❌ *Text Sticker Creation Failed*'
                },
                execute: this.createTextSticker.bind(this)
            },
            {
                name: 'anim',
                description: 'Create animated sticker from video/GIF',
                usage: '.anim (reply to video/GIF)',
                permissions: 'public',
                ui: {
                    processingText: '🎬 *Creating Animated Sticker...*\n\n⏳ Processing animation...',
                    errorText: '❌ *Animated Sticker Creation Failed*'
                },
                execute: this.createAnimatedSticker.bind(this)
            },
            {
                name: 'steal',
                description: 'Steal sticker and recreate with custom metadata',
                usage: '.steal <pack_name> | <author> (reply to sticker)',
                permissions: 'public',
                ui: {
                    processingText: '🕵️ *Stealing Sticker...*\n\n⏳ Recreating with new metadata...',
                    errorText: '❌ *Sticker Stealing Failed*'
                },
                execute: this.stealSticker.bind(this)
            }
        ];
        this.tempDir = path.join(__dirname, '../temp');
    }

    async init() {
        await fs.ensureDir(this.tempDir);
        console.log('✅ Sticker module initialized');
    }

    async createSticker(msg, params, context) {
        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        
        if (!quotedMsg) {
            return '❌ *Sticker Creation*\n\nPlease reply to an image or video to create a sticker.\n\n💡 Usage: Reply to media and type `.sticker` or `.s`';
        }

        try {
            let mediaBuffer;
            let mediaType;

            if (quotedMsg.imageMessage) {
                const stream = await downloadContentFromMessage(quotedMsg.imageMessage, 'image');
                const chunks = [];
                for await (const chunk of stream) {
                    chunks.push(chunk);
                }
                mediaBuffer = Buffer.concat(chunks);
                mediaType = 'image';
            } else if (quotedMsg.videoMessage) {
                const stream = await downloadContentFromMessage(quotedMsg.videoMessage, 'video');
                const chunks = [];
                for await (const chunk of stream) {
                    chunks.push(chunk);
                }
                mediaBuffer = Buffer.concat(chunks);
                mediaType = 'video';
            } else {
                return '❌ *Unsupported Media*\n\nPlease reply to an image or video file.';
            }

            // Create sticker
            const sticker = new Sticker(mediaBuffer, {
                pack: 'HyperWa Stickers',
                author: 'HyperWa Bot',
                type: mediaType === 'video' ? StickerTypes.FULL : StickerTypes.DEFAULT,
                categories: ['🤖', '💬'],
                id: `hyperwa-${Date.now()}`,
                quality: 50
            });

            const stickerBuffer = await sticker.toBuffer();

            await context.bot.sendMessage(context.sender, {
                sticker: stickerBuffer
            });

            return `✅ *Sticker Created Successfully*\n\n🎨 Type: ${mediaType.toUpperCase()}\n📦 Pack: HyperWa Stickers\n⏰ ${new Date().toLocaleTimeString()}`;

        } catch (error) {
            throw new Error(`Sticker creation failed: ${error.message}`);
        }
    }

    async createTextSticker(msg, params, context) {
        if (params.length === 0) {
            return '❌ *Text Sticker*\n\nPlease provide text to create a sticker.\n\n💡 Usage: `.textsticker <text>`\n📝 Example: `.textsticker Hello World!`';
        }

        const text = params.join(' ');

        if (text.length > 100) {
            return '❌ *Text Too Long*\n\nMaximum text length is 100 characters.\nCurrent length: ' + text.length;
        }

        try {
            // Create a simple text image using canvas or similar
            const textImageBuffer = await this.createTextImage(text);

            const sticker = new Sticker(textImageBuffer, {
                pack: 'HyperWa Text Stickers',
                author: 'HyperWa Bot',
                type: StickerTypes.DEFAULT,
                categories: ['📝', '💬'],
                id: `hyperwa-text-${Date.now()}`,
                quality: 50
            });

            const stickerBuffer = await sticker.toBuffer();

            await context.bot.sendMessage(context.sender, {
                sticker: stickerBuffer
            });

            return `✅ *Text Sticker Created*\n\n📝 Text: "${text}"\n📦 Pack: HyperWa Text Stickers\n⏰ ${new Date().toLocaleTimeString()}`;

        } catch (error) {
            throw new Error(`Text sticker creation failed: ${error.message}`);
        }
    }

    async createAnimatedSticker(msg, params, context) {
        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        
        if (!quotedMsg?.videoMessage) {
            return '❌ *Animated Sticker*\n\nPlease reply to a video or GIF to create an animated sticker.\n\n💡 Usage: Reply to a video/GIF and type `.anim`';
        }

        try {
            const videoMessage = quotedMsg.videoMessage;
            
            // Check video duration (max 6 seconds for animated stickers)
            if (videoMessage.seconds && videoMessage.seconds > 6) {
                return '❌ *Video Too Long*\n\nAnimated stickers must be 6 seconds or less.\nVideo duration: ' + Math.round(videoMessage.seconds) + ' seconds';
            }

            const stream = await downloadContentFromMessage(videoMessage, 'video');
            const chunks = [];
            for await (const chunk of stream) {
                chunks.push(chunk);
            }
            const mediaBuffer = Buffer.concat(chunks);

            // Create animated sticker
            const sticker = new Sticker(mediaBuffer, {
                pack: 'HyperWa Animated',
                author: 'HyperWa Bot',
                type: StickerTypes.FULL,
                categories: ['🎬', '🎭'],
                id: `hyperwa-anim-${Date.now()}`,
                quality: 30 // Lower quality for animated stickers
            });

            const stickerBuffer = await sticker.toBuffer();

            await context.bot.sendMessage(context.sender, {
                sticker: stickerBuffer
            });

            return `✅ *Animated Sticker Created*\n\n🎬 Duration: ${Math.round(videoMessage.seconds || 0)}s\n📦 Pack: HyperWa Animated\n⏰ ${new Date().toLocaleTimeString()}`;

        } catch (error) {
            throw new Error(`Animated sticker creation failed: ${error.message}`);
        }
    }

    async stealSticker(msg, params, context) {
        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        
        if (!quotedMsg?.stickerMessage) {
            return '❌ *Sticker Stealing*\n\nPlease reply to a sticker to steal it.\n\n💡 Usage: Reply to a sticker and type `.steal <pack_name> | <author>`\n📝 Example: `.steal My Pack | My Name`';
        }

        let packName = 'HyperWa Stolen';
        let authorName = 'HyperWa Bot';

        if (params.length > 0) {
            const input = params.join(' ');
            const parts = input.split('|').map(part => part.trim());
            
            if (parts.length >= 1 && parts[0]) {
                packName = parts[0];
            }
            if (parts.length >= 2 && parts[1]) {
                authorName = parts[1];
            }
        }

        try {
            const stream = await downloadContentFromMessage(quotedMsg.stickerMessage, 'sticker');
            const chunks = [];
            for await (const chunk of stream) {
                chunks.push(chunk);
            }
            const stickerBuffer = Buffer.concat(chunks);

            // Recreate sticker with new metadata
            const sticker = new Sticker(stickerBuffer, {
                pack: packName,
                author: authorName,
                type: quotedMsg.stickerMessage.isAnimated ? StickerTypes.FULL : StickerTypes.DEFAULT,
                categories: ['🕵️', '💫'],
                id: `hyperwa-stolen-${Date.now()}`,
                quality: 50
            });

            const newStickerBuffer = await sticker.toBuffer();

            await context.bot.sendMessage(context.sender, {
                sticker: newStickerBuffer
            });

            return `🕵️ *Sticker Stolen Successfully*\n\n📦 New Pack: "${packName}"\n👤 New Author: "${authorName}"\n🎭 Type: ${quotedMsg.stickerMessage.isAnimated ? 'Animated' : 'Static'}\n⏰ ${new Date().toLocaleTimeString()}`;

        } catch (error) {
            throw new Error(`Sticker stealing failed: ${error.message}`);
        }
    }

    async createTextImage(text) {
        // This is a placeholder for text-to-image conversion
        // You would use a library like canvas, sharp, or jimp to create an actual image
        // For now, we'll create a simple colored rectangle as a placeholder
        
        try {
            const sharp = require('sharp');
            
            const svg = `
                <svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
                    <rect width="512" height="512" fill="#ffffff"/>
                    <text x="256" y="256" font-family="Arial, sans-serif" font-size="40" 
                          text-anchor="middle" dominant-baseline="middle" fill="#000000">
                        ${text}
                    </text>
                </svg>
            `;
            
            return await sharp(Buffer.from(svg))
                .png()
                .toBuffer();
                
        } catch (error) {
            // Fallback: create a simple placeholder
            console.warn('Sharp not available, using placeholder for text sticker');
            
            // Return a minimal PNG buffer (this is just a placeholder)
            // In production, you'd want to use a proper image generation library
            throw new Error('Text sticker creation requires image processing library (sharp)');
        }
    }

    async destroy() {
        await fs.remove(this.tempDir);
        console.log('🛑 Sticker module destroyed');
    }
}

module.exports = StickerModule;