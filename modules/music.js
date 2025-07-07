const axios = require('axios');
const ytdl = require('ytdl-core');
const fs = require('fs-extra');
const path = require('path');

class MusicModule {
    constructor(bot) {
        this.bot = bot;
        this.name = 'music';
        this.metadata = {
            description: 'Music search, download, and information services',
            version: '1.0.0',
            author: 'HyperWa Team',
            category: 'entertainment',
            dependencies: ['ytdl-core', 'axios']
        };
        this.commands = [
            {
                name: 'play',
                description: 'Search and download music from YouTube',
                usage: '.play <song name>',
                permissions: 'public',
                ui: {
                    processingText: '🎵 *Searching Music...*\n\n⏳ Finding your song...',
                    errorText: '❌ *Music Search Failed*'
                },
                execute: this.playMusic.bind(this)
            },
            {
                name: 'lyrics',
                description: 'Get song lyrics',
                usage: '.lyrics <song name> - <artist>',
                permissions: 'public',
                ui: {
                    processingText: '📝 *Fetching Lyrics...*\n\n⏳ Searching for lyrics...',
                    errorText: '❌ *Lyrics Not Found*'
                },
                execute: this.getLyrics.bind(this)
            },
            {
                name: 'spotify',
                description: 'Search Spotify for track information',
                usage: '.spotify <song name>',
                permissions: 'public',
                ui: {
                    processingText: '🎧 *Searching Spotify...*\n\n⏳ Getting track info...',
                    errorText: '❌ *Spotify Search Failed*'
                },
                execute: this.searchSpotify.bind(this)
            },
            {
                name: 'shazam',
                description: 'Identify music from audio (reply to audio)',
                usage: '.shazam (reply to audio)',
                permissions: 'public',
                ui: {
                    processingText: '🎵 *Identifying Music...*\n\n⏳ Analyzing audio...',
                    errorText: '❌ *Music Recognition Failed*'
                },
                execute: this.identifyMusic.bind(this)
            },
            {
                name: 'trending',
                description: 'Get trending music',
                usage: '.trending [country]',
                permissions: 'public',
                ui: {
                    processingText: '📈 *Fetching Trending Music...*\n\n⏳ Getting popular tracks...',
                    errorText: '❌ *Failed to Fetch Trending*'
                },
                execute: this.getTrendingMusic.bind(this)
            }
        ];
        this.tempDir = path.join(__dirname, '../temp');
        // API keys would be needed for full functionality
        this.spotifyClientId = 'YOUR_SPOTIFY_CLIENT_ID';
        this.spotifyClientSecret = 'YOUR_SPOTIFY_CLIENT_SECRET';
        this.lyricsApiKey = 'YOUR_LYRICS_API_KEY';
    }

    async init() {
        await fs.ensureDir(this.tempDir);
        console.log('✅ Music module initialized');
    }

    async playMusic(msg, params, context) {
        if (params.length === 0) {
            return '❌ *Music Player*\n\nPlease provide a song name to search.\n\n💡 Usage: `.play <song name>`\n📝 Example: `.play Bohemian Rhapsody`';
        }

        const query = params.join(' ');

        try {
            // Search YouTube for the song
            const searchResults = await this.searchYouTube(query);
            
            if (!searchResults || searchResults.length === 0) {
                return `❌ *No Results Found*\n\nCouldn't find any music for "${query}".\nTry different keywords or artist name.`;
            }

            const video = searchResults[0];
            const videoUrl = `https://www.youtube.com/watch?v=${video.id}`;

            // Check if it's a valid music video (duration check)
            if (video.duration > 600) { // 10 minutes
                return '❌ *Video Too Long*\n\nMusic downloads are limited to 10 minutes.\nVideo duration: ' + Math.floor(video.duration / 60) + ' minutes';
            }

            // Get video info
            const info = await ytdl.getInfo(videoUrl);
            const title = info.videoDetails.title;
            const author = info.videoDetails.author.name;
            const duration = info.videoDetails.lengthSeconds;

            // Download audio
            const fileName = `music_${Date.now()}.mp3`;
            const filePath = path.join(this.tempDir, fileName);

            const stream = ytdl(videoUrl, { 
                quality: 'highestaudio',
                filter: 'audioonly'
            });
            
            stream.pipe(fs.createWriteStream(filePath));
            
            await new Promise((resolve, reject) => {
                stream.on('end', resolve);
                stream.on('error', reject);
            });

            // Send audio file
            await context.bot.sendMessage(context.sender, {
                audio: { url: filePath },
                mimetype: 'audio/mp4',
                caption: `🎵 *${title}*\n\n👤 Artist: ${author}\n⏱️ Duration: ${this.formatDuration(duration)}\n📱 Downloaded via HyperWa`
            });

            // Cleanup after 5 minutes
            setTimeout(() => fs.remove(filePath), 300000);

            return `✅ *Music Downloaded*\n\n🎵 Title: ${title}\n👤 Artist: ${author}\n⏱️ Duration: ${this.formatDuration(duration)}\n⏰ ${new Date().toLocaleTimeString()}`;

        } catch (error) {
            throw new Error(`Music download failed: ${error.message}`);
        }
    }

    async getLyrics(msg, params, context) {
        if (params.length === 0) {
            return '❌ *Lyrics Search*\n\nPlease provide song name and artist.\n\n💡 Usage: `.lyrics <song> - <artist>`\n📝 Example: `.lyrics Bohemian Rhapsody - Queen`';
        }

        const query = params.join(' ');
        let songName, artistName;

        if (query.includes(' - ')) {
            [songName, artistName] = query.split(' - ').map(s => s.trim());
        } else {
            songName = query;
            artistName = '';
        }

        try {
            // This is a placeholder for lyrics API integration
            // You would integrate with services like:
            // - Genius API
            // - Musixmatch API
            // - LyricFind API
            // - AZLyrics scraping (with permission)

            const lyrics = await this.fetchLyrics(songName, artistName);

            if (!lyrics) {
                return `❌ *Lyrics Not Found*\n\nCouldn't find lyrics for "${songName}"${artistName ? ` by ${artistName}` : ''}.\nTry with different spelling or include artist name.`;
            }

            // Truncate if too long for WhatsApp
            const maxLength = 4000;
            const truncatedLyrics = lyrics.length > maxLength 
                ? lyrics.substring(0, maxLength) + '\n\n... (lyrics truncated)'
                : lyrics;

            return `🎵 *Lyrics Found*\n\n**${songName}**${artistName ? ` - ${artistName}` : ''}\n\n${truncatedLyrics}\n\n⏰ ${new Date().toLocaleTimeString()}`;

        } catch (error) {
            throw new Error(`Lyrics search failed: ${error.message}`);
        }
    }

    async searchSpotify(msg, params, context) {
        if (params.length === 0) {
            return '❌ *Spotify Search*\n\nPlease provide a song name to search.\n\n💡 Usage: `.spotify <song name>`\n📝 Example: `.spotify Blinding Lights`';
        }

        const query = params.join(' ');

        try {
            if (this.spotifyClientId === 'YOUR_SPOTIFY_CLIENT_ID') {
                return '⚠️ *Spotify Search*\n\nSpotify API credentials not configured.\nPlease set up Spotify API keys for track information.';
            }

            // Get Spotify access token
            const token = await this.getSpotifyToken();
            
            // Search for tracks
            const response = await axios.get('https://api.spotify.com/v1/search', {
                headers: {
                    'Authorization': `Bearer ${token}`
                },
                params: {
                    q: query,
                    type: 'track',
                    limit: 5
                }
            });

            const tracks = response.data.tracks.items;

            if (!tracks || tracks.length === 0) {
                return `❌ *No Tracks Found*\n\nCouldn't find any tracks for "${query}" on Spotify.`;
            }

            let resultText = `🎧 *Spotify Search Results*\n\nQuery: "${query}"\n\n`;

            tracks.forEach((track, index) => {
                const artists = track.artists.map(artist => artist.name).join(', ');
                const album = track.album.name;
                const duration = this.formatDuration(Math.floor(track.duration_ms / 1000));
                const popularity = track.popularity;

                resultText += `${index + 1}. **${track.name}**\n`;
                resultText += `   👤 ${artists}\n`;
                resultText += `   💿 ${album}\n`;
                resultText += `   ⏱️ ${duration} • 📊 ${popularity}% popular\n`;
                resultText += `   🔗 ${track.external_urls.spotify}\n\n`;
            });

            return resultText;

        } catch (error) {
            throw new Error(`Spotify search failed: ${error.message}`);
        }
    }

    async identifyMusic(msg, params, context) {
        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        
        if (!quotedMsg?.audioMessage) {
            return '❌ *Music Recognition*\n\nPlease reply to an audio message to identify the music.\n\n💡 Usage: Reply to audio and type `.shazam`';
        }

        try {
            // This is a placeholder for music recognition
            // You would integrate with services like:
            // - Shazam API
            // - ACRCloud
            // - AudD Music Recognition API
            // - AudioTag

            return '⚠️ *Music Recognition*\n\nMusic identification service not configured.\nPlease set up Shazam or ACRCloud API for music recognition.';

        } catch (error) {
            throw new Error(`Music identification failed: ${error.message}`);
        }
    }

    async getTrendingMusic(msg, params, context) {
        const country = params[0]?.toUpperCase() || 'US';

        try {
            // This would integrate with music charts APIs
            // Like Billboard, Spotify Charts, Apple Music Charts, etc.

            const trendingTracks = await this.fetchTrendingTracks(country);

            if (!trendingTracks || trendingTracks.length === 0) {
                return `❌ *No Trending Data*\n\nCouldn't fetch trending music for ${country}.`;
            }

            let trendingText = `📈 *Trending Music in ${country}*\n\n`;

            trendingTracks.forEach((track, index) => {
                trendingText += `${index + 1}. **${track.title}**\n`;
                trendingText += `   👤 ${track.artist}\n`;
                trendingText += `   📊 Position: #${track.position}\n\n`;
            });

            trendingText += `⏰ Updated: ${new Date().toLocaleString()}`;

            return trendingText;

        } catch (error) {
            throw new Error(`Failed to fetch trending music: ${error.message}`);
        }
    }

    async searchYouTube(query) {
        // This is a placeholder for YouTube search
        // You would use YouTube Data API v3 for actual implementation
        try {
            // Placeholder response
            return [{
                id: 'placeholder',
                title: `Search result for: ${query}`,
                duration: 240, // 4 minutes
                author: 'Unknown Artist'
            }];
        } catch (error) {
            return [];
        }
    }

    async fetchLyrics(songName, artistName) {
        // Placeholder for lyrics fetching
        // You would integrate with lyrics APIs here
        return null;
    }

    async getSpotifyToken() {
        // Placeholder for Spotify token generation
        throw new Error('Spotify API not configured');
    }

    async fetchTrendingTracks(country) {
        // Placeholder for trending tracks
        return [
            { title: 'Sample Song 1', artist: 'Sample Artist 1', position: 1 },
            { title: 'Sample Song 2', artist: 'Sample Artist 2', position: 2 },
            { title: 'Sample Song 3', artist: 'Sample Artist 3', position: 3 }
        ];
    }

    formatDuration(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    async destroy() {
        await fs.remove(this.tempDir);
        console.log('🛑 Music module destroyed');
    }
}

module.exports = MusicModule;