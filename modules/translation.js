const axios = require('axios');

class TranslationModule {
    constructor(bot) {
        this.bot = bot;
        this.name = 'translation';
        this.metadata = {
            description: 'Language translation and text processing',
            version: '1.0.0',
            author: 'HyperWa Team',
            category: 'utility',
            dependencies: ['axios']
        };
        this.commands = [
            {
                name: 'tr',
                description: 'Translate text to another language',
                usage: '.tr <target_language> <text>',
                permissions: 'public',
                ui: {
                    processingText: '🌐 *Translating Text...*\n\n⏳ Processing translation...',
                    errorText: '❌ *Translation Failed*'
                },
                execute: this.translateText.bind(this)
            },
            {
                name: 'detect',
                description: 'Detect language of text',
                usage: '.detect <text>',
                permissions: 'public',
                ui: {
                    processingText: '🔍 *Detecting Language...*\n\n⏳ Analyzing text...',
                    errorText: '❌ *Language Detection Failed*'
                },
                execute: this.detectLanguage.bind(this)
            },
            {
                name: 'langs',
                description: 'List supported languages',
                usage: '.langs',
                permissions: 'public',
                execute: this.listLanguages.bind(this)
            },
            {
                name: 'summary',
                description: 'Summarize long text',
                usage: '.summary <text>',
                permissions: 'public',
                ui: {
                    processingText: '📝 *Summarizing Text...*\n\n⏳ Creating summary...',
                    errorText: '❌ *Summarization Failed*'
                },
                execute: this.summarizeText.bind(this)
            }
        ];
        // Using Google Translate API (unofficial) - for production use official API
        this.translateApiUrl = 'https://translate.googleapis.com/translate_a/single';
    }

    async translateText(msg, params, context) {
        if (params.length < 2) {
            return '❌ *Text Translation*\n\nPlease provide target language and text.\n\n💡 Usage: `.tr <language> <text>`\n📝 Example: `.tr spanish Hello world`\n\n🌐 Use `.langs` to see supported languages';
        }

        const targetLang = params[0].toLowerCase();
        const text = params.slice(1).join(' ');

        if (text.length > 1000) {
            return '❌ *Text Too Long*\n\nMaximum text length is 1000 characters.\nCurrent length: ' + text.length;
        }

        try {
            const langCode = this.getLanguageCode(targetLang);
            if (!langCode) {
                return `❌ *Unsupported Language*\n\nLanguage "${targetLang}" is not supported.\nUse \`.langs\` to see available languages.`;
            }

            const response = await axios.get(this.translateApiUrl, {
                params: {
                    client: 'gtx',
                    sl: 'auto',
                    tl: langCode,
                    dt: 't',
                    q: text
                }
            });

            const translatedText = response.data[0][0][0];
            const detectedLang = response.data[2] || 'unknown';
            const confidence = response.data[6] || 0;

            return `🌐 *Translation Result*\n\n` +
                   `📝 **Original:** ${text}\n` +
                   `🔄 **Translated:** ${translatedText}\n\n` +
                   `🔍 **Detected Language:** ${this.getLanguageName(detectedLang)}\n` +
                   `🎯 **Target Language:** ${this.getLanguageName(langCode)}\n` +
                   `📊 **Confidence:** ${Math.round(confidence * 100)}%\n\n` +
                   `⏰ ${new Date().toLocaleTimeString()}`;

        } catch (error) {
            throw new Error(`Translation failed: ${error.message}`);
        }
    }

    async detectLanguage(msg, params, context) {
        if (params.length === 0) {
            return '❌ *Language Detection*\n\nPlease provide text to detect language.\n\n💡 Usage: `.detect <text>`\n📝 Example: `.detect Bonjour le monde`';
        }

        const text = params.join(' ');

        if (text.length > 500) {
            return '❌ *Text Too Long*\n\nMaximum text length for detection is 500 characters.\nCurrent length: ' + text.length;
        }

        try {
            const response = await axios.get(this.translateApiUrl, {
                params: {
                    client: 'gtx',
                    sl: 'auto',
                    tl: 'en',
                    dt: 't',
                    q: text
                }
            });

            const detectedLang = response.data[2] || 'unknown';
            const confidence = response.data[6] || 0;
            const translatedText = response.data[0][0][0];

            return `🔍 *Language Detection Result*\n\n` +
                   `📝 **Text:** ${text}\n` +
                   `🌐 **Detected Language:** ${this.getLanguageName(detectedLang)}\n` +
                   `📊 **Confidence:** ${Math.round(confidence * 100)}%\n` +
                   `🔄 **English Translation:** ${translatedText}\n\n` +
                   `⏰ ${new Date().toLocaleTimeString()}`;

        } catch (error) {
            throw new Error(`Language detection failed: ${error.message}`);
        }
    }

    async listLanguages(msg, params, context) {
        const languages = [
            '🇺🇸 english (en)', '🇪🇸 spanish (es)', '🇫🇷 french (fr)', '🇩🇪 german (de)',
            '🇮🇹 italian (it)', '🇵🇹 portuguese (pt)', '🇷🇺 russian (ru)', '🇯🇵 japanese (ja)',
            '🇰🇷 korean (ko)', '🇨🇳 chinese (zh)', '🇮🇳 hindi (hi)', '🇸🇦 arabic (ar)',
            '🇹🇷 turkish (tr)', '🇳🇱 dutch (nl)', '🇸🇪 swedish (sv)', '🇳🇴 norwegian (no)',
            '🇩🇰 danish (da)', '🇫🇮 finnish (fi)', '🇵🇱 polish (pl)', '🇨🇿 czech (cs)',
            '🇭🇺 hungarian (hu)', '🇷🇴 romanian (ro)', '🇧🇬 bulgarian (bg)', '🇭🇷 croatian (hr)',
            '🇸🇰 slovak (sk)', '🇸🇮 slovenian (sl)', '🇪🇪 estonian (et)', '🇱🇻 latvian (lv)',
            '🇱🇹 lithuanian (lt)', '🇲🇹 maltese (mt)', '🇮🇸 icelandic (is)', '🇮🇪 irish (ga)'
        ];

        let langText = `🌐 *Supported Languages*\n\n`;
        langText += `📋 **Available Languages (${languages.length}):**\n\n`;
        
        // Split into columns for better readability
        for (let i = 0; i < languages.length; i += 2) {
            langText += `${languages[i]}`;
            if (languages[i + 1]) {
                langText += `\n${languages[i + 1]}`;
            }
            langText += '\n\n';
        }

        langText += `💡 **Usage Examples:**\n`;
        langText += `• \`.tr spanish Hello world\`\n`;
        langText += `• \`.tr fr Good morning\`\n`;
        langText += `• \`.detect Hola mundo\``;

        return langText;
    }

    async summarizeText(msg, params, context) {
        if (params.length === 0) {
            return '❌ *Text Summarization*\n\nPlease provide text to summarize.\n\n💡 Usage: `.summary <long_text>`\n📝 Minimum 100 characters required';
        }

        const text = params.join(' ');

        if (text.length < 100) {
            return '❌ *Text Too Short*\n\nText must be at least 100 characters for meaningful summarization.\nCurrent length: ' + text.length;
        }

        if (text.length > 2000) {
            return '❌ *Text Too Long*\n\nMaximum text length is 2000 characters.\nCurrent length: ' + text.length;
        }

        try {
            // This is a simple extractive summarization
            // For production, you'd use AI services like OpenAI, Hugging Face, or Google's summarization API
            const summary = this.extractiveSummarization(text);

            return `📝 *Text Summary*\n\n` +
                   `📊 **Original Length:** ${text.length} characters\n` +
                   `📊 **Summary Length:** ${summary.length} characters\n` +
                   `📉 **Compression:** ${Math.round((1 - summary.length / text.length) * 100)}%\n\n` +
                   `📋 **Summary:**\n${summary}\n\n` +
                   `⏰ ${new Date().toLocaleTimeString()}`;

        } catch (error) {
            throw new Error(`Summarization failed: ${error.message}`);
        }
    }

    extractiveSummarization(text) {
        // Simple extractive summarization algorithm
        const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 10);
        
        if (sentences.length <= 3) {
            return text;
        }

        // Score sentences based on word frequency
        const words = text.toLowerCase().match(/\b\w+\b/g) || [];
        const wordFreq = {};
        words.forEach(word => {
            if (word.length > 3) { // Ignore short words
                wordFreq[word] = (wordFreq[word] || 0) + 1;
            }
        });

        // Score each sentence
        const sentenceScores = sentences.map(sentence => {
            const sentenceWords = sentence.toLowerCase().match(/\b\w+\b/g) || [];
            const score = sentenceWords.reduce((sum, word) => {
                return sum + (wordFreq[word] || 0);
            }, 0);
            return { sentence: sentence.trim(), score };
        });

        // Sort by score and take top sentences
        sentenceScores.sort((a, b) => b.score - a.score);
        const topSentences = sentenceScores.slice(0, Math.max(2, Math.ceil(sentences.length * 0.3)));

        // Maintain original order
        const summary = sentences.filter(sentence => 
            topSentences.some(top => top.sentence === sentence.trim())
        ).join('. ') + '.';

        return summary;
    }

    getLanguageCode(language) {
        const langMap = {
            'english': 'en', 'spanish': 'es', 'french': 'fr', 'german': 'de',
            'italian': 'it', 'portuguese': 'pt', 'russian': 'ru', 'japanese': 'ja',
            'korean': 'ko', 'chinese': 'zh', 'hindi': 'hi', 'arabic': 'ar',
            'turkish': 'tr', 'dutch': 'nl', 'swedish': 'sv', 'norwegian': 'no',
            'danish': 'da', 'finnish': 'fi', 'polish': 'pl', 'czech': 'cs',
            'hungarian': 'hu', 'romanian': 'ro', 'bulgarian': 'bg', 'croatian': 'hr',
            'slovak': 'sk', 'slovenian': 'sl', 'estonian': 'et', 'latvian': 'lv',
            'lithuanian': 'lt', 'maltese': 'mt', 'icelandic': 'is', 'irish': 'ga'
        };
        return langMap[language.toLowerCase()] || language;
    }

    getLanguageName(code) {
        const codeMap = {
            'en': 'English', 'es': 'Spanish', 'fr': 'French', 'de': 'German',
            'it': 'Italian', 'pt': 'Portuguese', 'ru': 'Russian', 'ja': 'Japanese',
            'ko': 'Korean', 'zh': 'Chinese', 'hi': 'Hindi', 'ar': 'Arabic',
            'tr': 'Turkish', 'nl': 'Dutch', 'sv': 'Swedish', 'no': 'Norwegian',
            'da': 'Danish', 'fi': 'Finnish', 'pl': 'Polish', 'cs': 'Czech',
            'hu': 'Hungarian', 'ro': 'Romanian', 'bg': 'Bulgarian', 'hr': 'Croatian',
            'sk': 'Slovak', 'sl': 'Slovenian', 'et': 'Estonian', 'lv': 'Latvian',
            'lt': 'Lithuanian', 'mt': 'Maltese', 'is': 'Icelandic', 'ga': 'Irish'
        };
        return codeMap[code] || code;
    }

    async init() {
        console.log('✅ Translation module initialized');
    }

    async destroy() {
        console.log('🛑 Translation module destroyed');
    }
}

module.exports = TranslationModule;