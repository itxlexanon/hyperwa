const axios = require('axios');

class WeatherModule {
    constructor(bot) {
        this.bot = bot;
        this.name = 'weather';
        this.metadata = {
            description: 'Get weather information for any location',
            version: '1.0.0',
            author: 'HyperWa Team',
            category: 'information',
            dependencies: ['axios']
        };
        this.commands = [
            {
                name: 'weather',
                description: 'Get current weather for a location',
                usage: '.weather <location>',
                permissions: 'public',
                ui: {
                    processingText: '🌤️ *Fetching Weather Data...*\n\n⏳ Getting current conditions...',
                    errorText: '❌ *Weather Fetch Failed*'
                },
                execute: this.getCurrentWeather.bind(this)
            },
            {
                name: 'forecast',
                description: 'Get 5-day weather forecast',
                usage: '.forecast <location>',
                permissions: 'public',
                ui: {
                    processingText: '📅 *Fetching Weather Forecast...*\n\n⏳ Getting 5-day forecast...',
                    errorText: '❌ *Forecast Fetch Failed*'
                },
                execute: this.getWeatherForecast.bind(this)
            },
            {
                name: 'alerts',
                description: 'Get weather alerts for a location',
                usage: '.alerts <location>',
                permissions: 'public',
                ui: {
                    processingText: '⚠️ *Checking Weather Alerts...*\n\n⏳ Scanning for warnings...',
                    errorText: '❌ *Alert Check Failed*'
                },
                execute: this.getWeatherAlerts.bind(this)
            }
        ];
        // Using OpenWeatherMap API - get free API key from https://openweathermap.org/api
        this.apiKey = 'YOUR_WEATHER_API_KEY'; // Replace with actual API key
        this.baseUrl = 'https://api.openweathermap.org/data/2.5';
    }

    async getCurrentWeather(msg, params, context) {
        if (params.length === 0) {
            return '❌ *Weather Information*\n\nPlease provide a location.\n\n💡 Usage: `.weather <location>`\n📝 Example: `.weather New York`';
        }

        const location = params.join(' ');

        try {
            const response = await axios.get(`${this.baseUrl}/weather`, {
                params: {
                    q: location,
                    appid: this.apiKey,
                    units: 'metric'
                }
            });

            const data = response.data;
            const temp = Math.round(data.main.temp);
            const feelsLike = Math.round(data.main.feels_like);
            const humidity = data.main.humidity;
            const pressure = data.main.pressure;
            const windSpeed = data.wind.speed;
            const windDir = this.getWindDirection(data.wind.deg);
            const visibility = data.visibility ? (data.visibility / 1000).toFixed(1) : 'N/A';
            const description = data.weather[0].description;
            const icon = this.getWeatherEmoji(data.weather[0].icon);
            const sunrise = new Date(data.sys.sunrise * 1000).toLocaleTimeString();
            const sunset = new Date(data.sys.sunset * 1000).toLocaleTimeString();

            return `🌤️ *Weather in ${data.name}, ${data.sys.country}*\n\n` +
                   `${icon} ${description.charAt(0).toUpperCase() + description.slice(1)}\n` +
                   `🌡️ Temperature: ${temp}°C (feels like ${feelsLike}°C)\n` +
                   `💧 Humidity: ${humidity}%\n` +
                   `🌪️ Wind: ${windSpeed} m/s ${windDir}\n` +
                   `📊 Pressure: ${pressure} hPa\n` +
                   `👁️ Visibility: ${visibility} km\n` +
                   `🌅 Sunrise: ${sunrise}\n` +
                   `🌇 Sunset: ${sunset}\n\n` +
                   `⏰ ${new Date().toLocaleString()}`;

        } catch (error) {
            if (error.response?.status === 404) {
                return `❌ *Location Not Found*\n\nCouldn't find weather data for "${location}".\nPlease check the spelling and try again.`;
            }
            if (error.response?.status === 401) {
                return '❌ *API Key Required*\n\nWeather API key is not configured.\nPlease set up OpenWeatherMap API key in the module configuration.';
            }
            throw new Error(`Weather fetch failed: ${error.message}`);
        }
    }

    async getWeatherForecast(msg, params, context) {
        if (params.length === 0) {
            return '❌ *Weather Forecast*\n\nPlease provide a location.\n\n💡 Usage: `.forecast <location>`\n📝 Example: `.forecast London`';
        }

        const location = params.join(' ');

        try {
            const response = await axios.get(`${this.baseUrl}/forecast`, {
                params: {
                    q: location,
                    appid: this.apiKey,
                    units: 'metric'
                }
            });

            const data = response.data;
            let forecastText = `📅 *5-Day Forecast for ${data.city.name}, ${data.city.country}*\n\n`;

            // Group forecasts by day
            const dailyForecasts = {};
            data.list.forEach(item => {
                const date = new Date(item.dt * 1000).toDateString();
                if (!dailyForecasts[date]) {
                    dailyForecasts[date] = [];
                }
                dailyForecasts[date].push(item);
            });

            // Get first 5 days
            const days = Object.keys(dailyForecasts).slice(0, 5);
            
            days.forEach((day, index) => {
                const dayData = dailyForecasts[day];
                const midDayData = dayData[Math.floor(dayData.length / 2)]; // Get middle forecast of the day
                
                const temp = Math.round(midDayData.main.temp);
                const description = midDayData.weather[0].description;
                const icon = this.getWeatherEmoji(midDayData.weather[0].icon);
                const humidity = midDayData.main.humidity;
                const windSpeed = midDayData.wind.speed;
                
                const dayName = index === 0 ? 'Today' : new Date(day).toLocaleDateString('en', { weekday: 'long' });
                
                forecastText += `${icon} **${dayName}**\n`;
                forecastText += `   🌡️ ${temp}°C • ${description}\n`;
                forecastText += `   💧 ${humidity}% • 🌪️ ${windSpeed} m/s\n\n`;
            });

            return forecastText;

        } catch (error) {
            if (error.response?.status === 404) {
                return `❌ *Location Not Found*\n\nCouldn't find weather data for "${location}".\nPlease check the spelling and try again.`;
            }
            if (error.response?.status === 401) {
                return '❌ *API Key Required*\n\nWeather API key is not configured.\nPlease set up OpenWeatherMap API key in the module configuration.';
            }
            throw new Error(`Forecast fetch failed: ${error.message}`);
        }
    }

    async getWeatherAlerts(msg, params, context) {
        if (params.length === 0) {
            return '❌ *Weather Alerts*\n\nPlease provide a location.\n\n💡 Usage: `.alerts <location>`\n📝 Example: `.alerts Miami`';
        }

        const location = params.join(' ');

        try {
            // First get coordinates
            const geoResponse = await axios.get(`${this.baseUrl}/weather`, {
                params: {
                    q: location,
                    appid: this.apiKey
                }
            });

            const { lat, lon } = geoResponse.data.coord;

            // Get alerts using One Call API
            const alertResponse = await axios.get(`https://api.openweathermap.org/data/3.0/onecall`, {
                params: {
                    lat: lat,
                    lon: lon,
                    appid: this.apiKey,
                    exclude: 'minutely,hourly,daily'
                }
            });

            const alerts = alertResponse.data.alerts;

            if (!alerts || alerts.length === 0) {
                return `✅ *No Weather Alerts*\n\nNo active weather alerts for ${geoResponse.data.name}, ${geoResponse.data.sys.country}.\n\n⏰ ${new Date().toLocaleString()}`;
            }

            let alertText = `⚠️ *Weather Alerts for ${geoResponse.data.name}*\n\n`;

            alerts.forEach((alert, index) => {
                const startTime = new Date(alert.start * 1000).toLocaleString();
                const endTime = new Date(alert.end * 1000).toLocaleString();
                
                alertText += `🚨 **${alert.event}**\n`;
                alertText += `📅 ${startTime} - ${endTime}\n`;
                alertText += `📝 ${alert.description.substring(0, 200)}...\n`;
                alertText += `🏢 Source: ${alert.sender_name}\n\n`;
            });

            return alertText;

        } catch (error) {
            if (error.response?.status === 404) {
                return `❌ *Location Not Found*\n\nCouldn't find weather data for "${location}".\nPlease check the spelling and try again.`;
            }
            if (error.response?.status === 401) {
                return '❌ *API Key Required*\n\nWeather API key is not configured or One Call API access is required for alerts.';
            }
            // If One Call API fails, return a message about basic weather
            return `⚠️ *Weather Alerts*\n\nWeather alerts require One Call API access.\nUse \`.weather ${location}\` for current conditions.`;
        }
    }

    getWeatherEmoji(iconCode) {
        const iconMap = {
            '01d': '☀️', '01n': '🌙',
            '02d': '⛅', '02n': '☁️',
            '03d': '☁️', '03n': '☁️',
            '04d': '☁️', '04n': '☁️',
            '09d': '🌧️', '09n': '🌧️',
            '10d': '🌦️', '10n': '🌧️',
            '11d': '⛈️', '11n': '⛈️',
            '13d': '❄️', '13n': '❄️',
            '50d': '🌫️', '50n': '🌫️'
        };
        return iconMap[iconCode] || '🌤️';
    }

    getWindDirection(degrees) {
        const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
        const index = Math.round(degrees / 22.5) % 16;
        return directions[index];
    }

    async init() {
        if (this.apiKey === 'YOUR_WEATHER_API_KEY') {
            console.warn('⚠️ Weather module: Please configure OpenWeatherMap API key for full functionality');
        }
        console.log('✅ Weather module initialized');
    }

    async destroy() {
        console.log('🛑 Weather module destroyed');
    }
}

module.exports = WeatherModule;