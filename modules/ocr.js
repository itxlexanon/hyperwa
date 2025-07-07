const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

class OCRModule {
    constructor(bot) {
        this.bot = bot;
        this.name = 'ocr';
        this.metadata = {
            description: 'Extract text from images using OCR technology',
            version: '1.0.0',
            author: 'HyperWa Team',
            category: 'utility',
            dependencies: ['axios', '@whiskeysockets/baileys']
        };
        this.commands = [
            {
                name: 'ocr',
                description: 'Extract text from image',
                usage: '.ocr (reply to image)',
                permissions: 'public',
                ui: {
                    processingText: '👁️ *Extracting Text from Image...*\n\n⏳ Analyzing image content...',
                    errorText: '❌ *OCR Processing Failed*'
                },
                execute: this.extractText.bind(this)
            },
            {
                name: 'translate',
                description: 'Extract and translate text from image',
                usage: '.translate <language> (reply to image)',
                permissions: 'public',
                ui: {
                    processingText: '🌐 *Extracting and Translating...*\n\n⏳ Processing image and translating...',
                    errorText: '❌ *Translation Failed*'
                },
                execute: this.extractAndTranslate.bind(this)
            }
        ];
        this.tempDir = path.join(__dirname, '../temp');
        // Using OCR.space API - get free API key from https://ocr.space/ocrapi
        this.ocrApiKey = 'YOUR_OCR_API_KEY'; // Replace with actual API key
        this.ocrApiUrl = 'https://api.ocr.space/parse/image';
    }

    async init() {
        await fs.ensureDir(this.tempDir);
        if (this.ocrApiKey === 'YOUR_OCR_API_KEY') {
            console.warn('⚠️ OCR module: Please configure OCR.space API key for full functionality');
        }
        console.log('✅ OCR module initialized');
    }

    async extractText(msg, params, context) {
        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        
        if (!quotedMsg?.imageMessage) {
            return '❌ *OCR Text Extraction*\n\nPlease reply to an image to extract text.\n\n💡 Usage: Reply to an image and type `.ocr`';
        }

        try {
            // Download the image
            const stream = await downloadContentFromMessage(quotedMsg.imageMessage, 'image');
            const chunks = [];
            for await (const chunk of stream) {
                chunks.push(chunk);
            }
            const buffer = Buffer.concat(chunks);

            // Save temporarily
            const fileName = `ocr_${Date.now()}.jpg`;
            const filePath = path.join(this.tempDir, fileName);
            await fs.writeFile(filePath, buffer);

            // Perform OCR
            const extractedText = await this.performOCR(filePath);

            // Cleanup
            await fs.remove(filePath);

            if (!extractedText || extractedText.trim().length === 0) {
                return '❌ *No Text Found*\n\nNo readable text was detected in the image.\nTry with a clearer image or different angle.';
            }

            return `👁️ *Text Extracted Successfully*\n\n📝 **Extracted Text:**\n${extractedText}\n\n📊 Characters: ${extractedText.length}\n⏰ ${new Date().toLocaleTimeString()}`;

        } catch (error) {
            throw new Error(`OCR processing failed: ${error.message}`);
        }
    }

    async extractAndTranslate(msg, params, context) {
        if (params.length === 0) {
            return '❌ *OCR Translation*\n\nPlease specify target language.\n\n💡 Usage: Reply to an image and type `.translate <language>`\n📝 Example: `.translate spanish`';
        }

        const targetLanguage = params[0].toLowerCase();
        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        
        if (!quotedMsg?.imageMessage) {
            return '❌ *OCR Translation*\n\nPlease reply to an image to extract and translate text.\n\n💡 Usage: Reply to an image and type `.translate <language>`';
        }

        try {
            // Download the image
            const stream = await downloadContentFromMessage(quotedMsg.imageMessage, 'image');
            const chunks = [];
            for await (const chunk of stream) {
                chunks.push(chunk);
            }
            const buffer = Buffer.concat(chunks);

            // Save temporarily
            const fileName = `ocr_translate_${Date.now()}.jpg`;
            const filePath = path.join(this.tempDir, fileName);
            await fs.writeFile(filePath, buffer);

            // Perform OCR
            const extractedText = await this.performOCR(filePath);

            // Cleanup
            await fs.remove(filePath);

            if (!extractedText || extractedText.trim().length === 0) {
                return '❌ *No Text Found*\n\nNo readable text was detected in the image.\nTry with a clearer image or different angle.';
            }

            // Translate the text (placeholder - you'd need to implement actual translation)
            const translatedText = await this.translateText(extractedText, targetLanguage);

            return `🌐 *Text Extracted and Translated*\n\n📝 **Original Text:**\n${extractedText}\n\n🔄 **Translated to ${targetLanguage}:**\n${translatedText}\n\n⏰ ${new Date().toLocaleTimeString()}`;

        } catch (error) {
            throw new Error(`OCR translation failed: ${error.message}`);
        }
    }

    async performOCR(imagePath) {
        if (this.ocrApiKey === 'YOUR_OCR_API_KEY') {
            // Fallback message when API key is not configured
            return 'OCR API key not configured. Please set up OCR.space API key for text extraction.';
        }

        try {
            const imageBuffer = await fs.readFile(imagePath);
            const base64Image = imageBuffer.toString('base64');

            const response = await axios.post(this.ocrApiUrl, {
                base64Image: `data:image/jpeg;base64,${base64Image}`,
                language: 'eng',
                isOverlayRequired: false,
                detectOrientation: true,
                scale: true,
                OCREngine: 2
            }, {
                headers: {
                    'apikey': this.ocrApiKey,
                    'Content-Type': 'application/json'
                }
            });

            if (response.data.IsErroredOnProcessing) {
                throw new Error(response.data.ErrorMessage || 'OCR processing failed');
            }

            const parsedResults = response.data.ParsedResults;
            if (!parsedResults || parsedResults.length === 0) {
                return '';
            }

            return parsedResults[0].ParsedText || '';

        } catch (error) {
            console.error('OCR API error:', error);
            throw new Error(`OCR service error: ${error.message}`);
        }
    }

    async translateText(text, targetLanguage) {
        // This is a placeholder for translation functionality
        // You would integrate with Google Translate API, Microsoft Translator, or similar service
        return `[Translation to ${targetLanguage} would appear here - please configure translation API]`;
    }

    async destroy() {
        await fs.remove(this.tempDir);
        console.log('🛑 OCR module destroyed');
    }
}

module.exports = OCRModule;