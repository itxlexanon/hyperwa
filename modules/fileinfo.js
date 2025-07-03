const path = require('path');
const fs = require('fs-extra');
const logger = require('./logger');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

class FileInfoModule {
    constructor(bot) {
        if (!bot || !bot.messageHandler || !bot.sock) {
            throw new Error('Invalid bot object: missing messageHandler or sock');
        }
        this.bot = bot;
        this.name = 'fileinfo';
        this.metadata = {
            description: 'Provides detailed metadata for files (audio, video, voice, documents, etc.)',
            version: '1.0.0',
            author: 'Bot Developer',
            category: 'Utility'
        };
        this.commands = [
            {
                name: 'details',
                description: 'Show metadata of a replied file (audio, video, voice, document, etc.)',
                usage: '.details (reply to a file)',
                permissions: 'public',
                execute: this.handleDetailsCommand.bind(this)
            }
        ];
    }

    async init() {
        logger.info(`✅ ${this.name} module initialized`);
    }

    async destroy() {
        logger.info(`🗑️ ${this.name} module destroyed`);
    }

    async handleDetailsCommand(msg, params, context) {
        try {
            const message = msg.message;
            if (!msg.quoted || !msg.quoted.message) {
                return await context.bot.sendMessage(context.sender, {
                    text: '❌ *File Info*\n\nPlease reply to a file (audio, video, voice, document, etc.) to get its details.'
                });
            }

            const quotedMessage = msg.quoted.message;
            const fileTypes = [
                'audioMessage',
                'videoMessage',
                'documentMessage',
                'imageMessage',
                'stickerMessage'
            ];

            const fileType = fileTypes.find(type => quotedMessage[type]);
            if (!fileType) {
                return await context.bot.sendMessage(context.sender, {
                    text: '❌ *File Info*\n\nThe replied message does not contain a supported file type.'
                });
            }

            const processingMsg = await context.bot.sendMessage(context.sender, {
                text: '⏳ *File Info*\n\nFetching file metadata... Please wait...'
            });

            const fileData = quotedMessage[fileType];
            const stream = await downloadContentFromMessage(fileData, fileType.replace('Message', '').toLowerCase());
            
            const chunks = [];
            for await (const chunk of stream) {
                chunks.push(chunk);
            }
            const buffer = Buffer.concat(chunks);

            let metadataText = `📄 *File Details*\n\n`;
            metadataText += `🗂️ *Type*: ${fileType.replace('Message', '')}\n`;
            metadataText += `📜 *MIME Type*: ${fileData.mimeType || 'Unknown'}\n`;
            
            if (fileData.fileName) {
                metadataText += `📛 *Name*: ${fileData.fileName}\n`;
            }
            
            metadataText += `📏 *Size*: ${(buffer.length / 1024).toFixed(2)} KB\n`;

            if (fileData.fileLength) {
                metadataText += `📐 *Length*: ${(Number(fileData.fileLength) / 1024).toFixed(2)} KB\n`;
            }

            if (fileType === 'audioMessage' || fileType === 'videoMessage') {
                if (fileData.seconds) {
                    const duration = fileData.seconds;
                    const minutes = Math.floor(duration / 60);
                    const seconds = duration % 60;
                    metadataText += `⏱️ *Duration*: ${minutes}m ${seconds}s\n`;
                }
            }

            if (fileType === 'videoMessage' || fileType === 'imageMessage') {
                if (fileData.height && fileData.width) {
                    metadataText += `📐 *Resolution*: ${fileData.width}x${fileData.height}\n`;
                }
            }

            if (fileType === 'documentMessage') {
                if (fileData.title) {
                    metadataText += `📝 *Title*: ${fileData.title}\n`;
                }
                if (fileData.pageCount) {
                    metadataText += `📃 *Pages*: ${fileData.pageCount}\n`;
                }
            }

            metadataText += `⏰ *Timestamp*: ${new Date(msg.messageTimestamp * 1000).toLocaleString()}\n`;

            const tempPath = path.join(__dirname, '../temp', `${Date.now()}_${fileData.fileName || 'file'}`);
            await fs.ensureDir(path.dirname(tempPath));
            await fs.writeFile(tempPath, buffer);
            
            const stats = await fs.stat(tempPath);
            metadataText += `📅 *Created*: ${stats.birthtime.toLocaleString()}\n`;
            metadataText += `🔄 *Modified*: ${stats.mtime.toLocaleString()}\n`;

            await fs.remove(tempPath);

            await context.bot.sock.sendMessage(context.sender, {
                text: metadataText,
                edit: processingMsg.key
            });

        } catch (error) {
            logger.error('Failed to fetch file details:', error);
            await context.bot.sendMessage(context.sender, {
                text: `❌ *File Info Failed*\n\n🚫 Error: ${error.message}`
            });
        }
    }
}

module.exports = FileInfoModule;
