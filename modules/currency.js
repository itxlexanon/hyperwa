const axios = require('axios');

class CurrencyModule {
    constructor(bot) {
        this.bot = bot;
        this.name = 'currency';
        this.metadata = {
            description: 'Currency conversion and exchange rates',
            version: '1.0.0',
            author: 'HyperWa Team',
            category: 'utility',
            dependencies: ['axios']
        };
        this.commands = [
            {
                name: 'convert',
                description: 'Convert currency',
                usage: '.convert <amount> <from> <to>',
                permissions: 'public',
                ui: {
                    processingText: '💱 *Converting Currency...*\n\n⏳ Fetching latest exchange rates...',
                    errorText: '❌ *Currency Conversion Failed*'
                },
                execute: this.convertCurrency.bind(this)
            },
            {
                name: 'rates',
                description: 'Get exchange rates for a currency',
                usage: '.rates <currency>',
                permissions: 'public',
                ui: {
                    processingText: '📊 *Fetching Exchange Rates...*\n\n⏳ Getting latest rates...',
                    errorText: '❌ *Failed to Fetch Rates*'
                },
                execute: this.getExchangeRates.bind(this)
            },
            {
                name: 'crypto',
                description: 'Get cryptocurrency prices',
                usage: '.crypto <symbol>',
                permissions: 'public',
                ui: {
                    processingText: '₿ *Fetching Crypto Prices...*\n\n⏳ Getting market data...',
                    errorText: '❌ *Failed to Fetch Crypto Data*'
                },
                execute: this.getCryptoPrice.bind(this)
            },
            {
                name: 'currencies',
                description: 'List supported currencies',
                usage: '.currencies',
                permissions: 'public',
                execute: this.listCurrencies.bind(this)
            }
        ];
        this.apiUrl = 'https://api.exchangerate-api.com/v4/latest';
        this.cryptoApiUrl = 'https://api.coingecko.com/api/v3';
    }

    async convertCurrency(msg, params, context) {
        if (params.length < 3) {
            return '❌ *Currency Converter*\n\nPlease provide amount, from currency, and to currency.\n\n💡 Usage: `.convert <amount> <from> <to>`\n📝 Example: `.convert 100 USD EUR`';
        }

        const amount = parseFloat(params[0]);
        const fromCurrency = params[1].toUpperCase();
        const toCurrency = params[2].toUpperCase();

        if (isNaN(amount) || amount <= 0) {
            return '❌ *Invalid Amount*\n\nPlease provide a valid positive number.';
        }

        try {
            const response = await axios.get(`${this.apiUrl}/${fromCurrency}`);
            const rates = response.data.rates;

            if (!rates[toCurrency]) {
                return `❌ *Currency Not Found*\n\nCurrency "${toCurrency}" is not supported.\nUse \`.currencies\` to see supported currencies.`;
            }

            const convertedAmount = (amount * rates[toCurrency]).toFixed(2);
            const rate = rates[toCurrency].toFixed(4);

            return `💱 *Currency Conversion*\n\n💰 ${amount} ${fromCurrency} = ${convertedAmount} ${toCurrency}\n📊 Exchange Rate: 1 ${fromCurrency} = ${rate} ${toCurrency}\n⏰ ${new Date().toLocaleString()}`;

        } catch (error) {
            if (error.response?.status === 404) {
                return `❌ *Currency Not Found*\n\nCurrency "${fromCurrency}" is not supported.\nUse \`.currencies\` to see supported currencies.`;
            }
            throw new Error(`Currency conversion failed: ${error.message}`);
        }
    }

    async getExchangeRates(msg, params, context) {
        if (params.length === 0) {
            return '❌ *Exchange Rates*\n\nPlease provide a base currency.\n\n💡 Usage: `.rates <currency>`\n📝 Example: `.rates USD`';
        }

        const baseCurrency = params[0].toUpperCase();

        try {
            const response = await axios.get(`${this.apiUrl}/${baseCurrency}`);
            const rates = response.data.rates;

            const majorCurrencies = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'CNY', 'INR', 'KRW'];
            const filteredRates = majorCurrencies
                .filter(currency => currency !== baseCurrency && rates[currency])
                .map(currency => `${currency}: ${rates[currency].toFixed(4)}`)
                .join('\n');

            return `📊 *Exchange Rates for ${baseCurrency}*\n\n${filteredRates}\n\n⏰ Last Updated: ${new Date(response.data.date).toLocaleDateString()}`;

        } catch (error) {
            if (error.response?.status === 404) {
                return `❌ *Currency Not Found*\n\nCurrency "${baseCurrency}" is not supported.\nUse \`.currencies\` to see supported currencies.`;
            }
            throw new Error(`Failed to fetch exchange rates: ${error.message}`);
        }
    }

    async getCryptoPrice(msg, params, context) {
        if (params.length === 0) {
            return '❌ *Cryptocurrency Prices*\n\nPlease provide a cryptocurrency symbol.\n\n💡 Usage: `.crypto <symbol>`\n📝 Example: `.crypto bitcoin`';
        }

        const symbol = params[0].toLowerCase();

        try {
            const response = await axios.get(`${this.cryptoApiUrl}/simple/price`, {
                params: {
                    ids: symbol,
                    vs_currencies: 'usd,eur,btc',
                    include_24hr_change: true,
                    include_market_cap: true
                }
            });

            const data = response.data[symbol];
            if (!data) {
                return `❌ *Cryptocurrency Not Found*\n\nCryptocurrency "${symbol}" not found.\nTry using full names like "bitcoin", "ethereum", "cardano".`;
            }

            const usdPrice = data.usd?.toLocaleString() || 'N/A';
            const eurPrice = data.eur?.toLocaleString() || 'N/A';
            const btcPrice = data.btc?.toFixed(8) || 'N/A';
            const change24h = data.usd_24h_change?.toFixed(2) || 'N/A';
            const changeEmoji = parseFloat(change24h) >= 0 ? '📈' : '📉';

            return `₿ *${symbol.toUpperCase()} Price*\n\n💵 USD: $${usdPrice}\n💶 EUR: €${eurPrice}\n₿ BTC: ${btcPrice}\n\n${changeEmoji} 24h Change: ${change24h}%\n⏰ ${new Date().toLocaleString()}`;

        } catch (error) {
            throw new Error(`Failed to fetch cryptocurrency data: ${error.message}`);
        }
    }

    async listCurrencies(msg, params, context) {
        const currencies = [
            'USD - US Dollar', 'EUR - Euro', 'GBP - British Pound', 'JPY - Japanese Yen',
            'AUD - Australian Dollar', 'CAD - Canadian Dollar', 'CHF - Swiss Franc',
            'CNY - Chinese Yuan', 'INR - Indian Rupee', 'KRW - South Korean Won',
            'BRL - Brazilian Real', 'RUB - Russian Ruble', 'MXN - Mexican Peso',
            'SGD - Singapore Dollar', 'HKD - Hong Kong Dollar', 'NOK - Norwegian Krone',
            'SEK - Swedish Krona', 'DKK - Danish Krone', 'PLN - Polish Zloty',
            'TRY - Turkish Lira', 'ZAR - South African Rand', 'NZD - New Zealand Dollar'
        ];

        return `💱 *Supported Currencies*\n\n${currencies.join('\n')}\n\n💡 Use currency codes (e.g., USD, EUR) in commands\n📝 Example: \`.convert 100 USD EUR\``;
    }

    async init() {
        console.log('✅ Currency module initialized');
    }

    async destroy() {
        console.log('🛑 Currency module destroyed');
    }
}

module.exports = CurrencyModule;