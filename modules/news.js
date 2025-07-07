const axios = require('axios');

class NewsModule {
    constructor(bot) {
        this.bot = bot;
        this.name = 'news';
        this.metadata = {
            description: 'Search and get latest news from various sources',
            version: '1.0.0',
            author: 'HyperWa Team',
            category: 'information',
            dependencies: ['axios']
        };
        this.commands = [
            {
                name: 'news',
                description: 'Get latest news headlines',
                usage: '.news [category]',
                permissions: 'public',
                ui: {
                    processingText: '📰 *Fetching Latest News...*\n\n⏳ Getting headlines...',
                    errorText: '❌ *Failed to Fetch News*'
                },
                execute: this.getNews.bind(this)
            },
            {
                name: 'search',
                description: 'Search news by keyword',
                usage: '.search <keyword>',
                permissions: 'public',
                ui: {
                    processingText: '🔍 *Searching News...*\n\n⏳ Finding relevant articles...',
                    errorText: '❌ *News Search Failed*'
                },
                execute: this.searchNews.bind(this)
            },
            {
                name: 'breaking',
                description: 'Get breaking news',
                usage: '.breaking',
                permissions: 'public',
                ui: {
                    processingText: '🚨 *Fetching Breaking News...*\n\n⏳ Getting urgent updates...',
                    errorText: '❌ *Failed to Fetch Breaking News*'
                },
                execute: this.getBreakingNews.bind(this)
            },
            {
                name: 'categories',
                description: 'List news categories',
                usage: '.categories',
                permissions: 'public',
                execute: this.listCategories.bind(this)
            }
        ];
        // Using free NewsAPI - you'll need to get an API key from https://newsapi.org/
        this.apiKey = 'YOUR_NEWS_API_KEY'; // Replace with actual API key
        this.baseUrl = 'https://newsapi.org/v2';
    }

    async getNews(msg, params, context) {
        const category = params[0]?.toLowerCase() || 'general';
        const validCategories = ['general', 'business', 'entertainment', 'health', 'science', 'sports', 'technology'];

        if (!validCategories.includes(category)) {
            return `❌ *Invalid Category*\n\nValid categories: ${validCategories.join(', ')}\n\n💡 Usage: \`.news [category]\``;
        }

        try {
            const response = await axios.get(`${this.baseUrl}/top-headlines`, {
                params: {
                    category: category,
                    country: 'us',
                    pageSize: 5,
                    apiKey: this.apiKey
                }
            });

            if (!response.data.articles || response.data.articles.length === 0) {
                return '❌ *No News Found*\n\nNo articles available for this category at the moment.';
            }

            const articles = response.data.articles.slice(0, 5);
            let newsText = `📰 *Latest ${category.charAt(0).toUpperCase() + category.slice(1)} News*\n\n`;

            articles.forEach((article, index) => {
                const title = article.title || 'No title';
                const source = article.source?.name || 'Unknown source';
                const publishedAt = new Date(article.publishedAt).toLocaleDateString();
                
                newsText += `${index + 1}. **${title}**\n`;
                newsText += `   📰 ${source} • ${publishedAt}\n`;
                if (article.description) {
                    newsText += `   📝 ${article.description.substring(0, 100)}...\n`;
                }
                newsText += `   🔗 ${article.url}\n\n`;
            });

            return newsText;

        } catch (error) {
            if (error.response?.status === 401) {
                return '❌ *API Key Required*\n\nNews API key is not configured.\nPlease set up NewsAPI key in the module configuration.';
            }
            throw new Error(`Failed to fetch news: ${error.message}`);
        }
    }

    async searchNews(msg, params, context) {
        if (params.length === 0) {
            return '❌ *News Search*\n\nPlease provide a search keyword.\n\n💡 Usage: `.search <keyword>`\n📝 Example: `.search technology`';
        }

        const query = params.join(' ');

        try {
            const response = await axios.get(`${this.baseUrl}/everything`, {
                params: {
                    q: query,
                    sortBy: 'publishedAt',
                    pageSize: 5,
                    language: 'en',
                    apiKey: this.apiKey
                }
            });

            if (!response.data.articles || response.data.articles.length === 0) {
                return `❌ *No Results Found*\n\nNo articles found for "${query}".`;
            }

            const articles = response.data.articles.slice(0, 5);
            let newsText = `🔍 *Search Results for "${query}"*\n\n`;

            articles.forEach((article, index) => {
                const title = article.title || 'No title';
                const source = article.source?.name || 'Unknown source';
                const publishedAt = new Date(article.publishedAt).toLocaleDateString();
                
                newsText += `${index + 1}. **${title}**\n`;
                newsText += `   📰 ${source} • ${publishedAt}\n`;
                if (article.description) {
                    newsText += `   📝 ${article.description.substring(0, 100)}...\n`;
                }
                newsText += `   🔗 ${article.url}\n\n`;
            });

            return newsText;

        } catch (error) {
            if (error.response?.status === 401) {
                return '❌ *API Key Required*\n\nNews API key is not configured.\nPlease set up NewsAPI key in the module configuration.';
            }
            throw new Error(`News search failed: ${error.message}`);
        }
    }

    async getBreakingNews(msg, params, context) {
        try {
            const response = await axios.get(`${this.baseUrl}/top-headlines`, {
                params: {
                    country: 'us',
                    pageSize: 3,
                    apiKey: this.apiKey
                }
            });

            if (!response.data.articles || response.data.articles.length === 0) {
                return '❌ *No Breaking News*\n\nNo breaking news available at the moment.';
            }

            const articles = response.data.articles.slice(0, 3);
            let newsText = `🚨 *Breaking News*\n\n`;

            articles.forEach((article, index) => {
                const title = article.title || 'No title';
                const source = article.source?.name || 'Unknown source';
                const publishedAt = new Date(article.publishedAt).toLocaleTimeString();
                
                newsText += `🔥 **${title}**\n`;
                newsText += `   📰 ${source} • ${publishedAt}\n`;
                if (article.description) {
                    newsText += `   📝 ${article.description.substring(0, 120)}...\n`;
                }
                newsText += `   🔗 ${article.url}\n\n`;
            });

            return newsText;

        } catch (error) {
            if (error.response?.status === 401) {
                return '❌ *API Key Required*\n\nNews API key is not configured.\nPlease set up NewsAPI key in the module configuration.';
            }
            throw new Error(`Failed to fetch breaking news: ${error.message}`);
        }
    }

    async listCategories(msg, params, context) {
        const categories = [
            '📰 general - General news',
            '💼 business - Business news',
            '🎬 entertainment - Entertainment news',
            '🏥 health - Health news',
            '🔬 science - Science news',
            '⚽ sports - Sports news',
            '💻 technology - Technology news'
        ];

        return `📋 *News Categories*\n\n${categories.join('\n')}\n\n💡 Usage: \`.news <category>\`\n📝 Example: \`.news technology\``;
    }

    async init() {
        if (this.apiKey === 'YOUR_NEWS_API_KEY') {
            console.warn('⚠️ News module: Please configure NewsAPI key for full functionality');
        }
        console.log('✅ News module initialized');
    }

    async destroy() {
        console.log('🛑 News module destroyed');
    }
}

module.exports = NewsModule;