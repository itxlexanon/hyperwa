const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const ytdl = require('ytdl-core');

class DownloaderModule {
    constructor(bot) {
        this.bot = bot;
        this.name = 'downloader';
        this.metadata = {
            description: 'Download media from various platforms (YouTube, Instagram, TikTok)',
            version: '1.0.0',
            author: 'HyperWa Team',
            category: 'media',
            dependencies: ['ytdl-core', 'axios']
        };
        this.commands = [
            {
                name: 'ytdl',
                description: 'Download YouTube video/audio',
                usage: '.ytdl <url> [video|audio]',
                permissions: 'public',
                ui: {
                    processingText: '📥 *Downloading from YouTube...*\n\n⏳ Please wait, this may take a moment...',
                    errorText: '❌ *YouTube Download Failed*'
                },
                execute: this.downloadYoutube.bind(this)
            },
            {
                name: 'igdl',
                description: 'Download Instagram post/story/reel',
                usage: '.igdl <url>',
                permissions: 'public',
                ui: {
                    processingText: '📥 *Downloading from Instagram...*\n\n⏳ Fetching media...',
                    errorText: '❌ *Instagram Download Failed*'
                },
                execute: this.downloadInstagram.bind(this)
            },
            {
                name: 'ttdl',
                description: 'Download TikTok video',
                usage: '.ttdl <url>',
                permissions: 'public',
                ui: {
                    processingText: '📥 *Downloading from TikTok...*\n\n⏳ Processing video...',
                    errorText: '❌ *TikTok Download Failed*'
                },
                execute: this.downloadTikTok.bind(this)
            }
        ];
        this.tempDir = path.join(__dirname, '../temp');
    }

    async init() {
        await fs.ensureDir(this.tempDir);
        console.log('✅ Downloader module initialized');
    }

    async downloadYoutube(msg, params, context) {
        if (params.length === 0) {
            return '❌ *YouTube Downloader*\n\nPlease provide a YouTube URL.\n\n💡 Usage: `.ytdl <url> [video|audio]`';
        }

        const url = params[0];
        const format = params[1]?.toLowerCase() || 'video';

        if (!ytdl.validateURL(url)) {
            return '❌ *Invalid YouTube URL*\n\nPlease provide a valid YouTube video URL.';
        }

        try {
            const info = await ytdl.getInfo(url);
            const title = info.videoDetails.title;
            const duration = info.videoDetails.lengthSeconds;

            if (duration > 600) { // 10 minutes limit
                return '❌ *Video Too Long*\n\nMaximum duration allowed: 10 minutes\nVideo duration: ' + Math.floor(duration / 60) + ' minutes';
            }

            const fileName = `${Date.now()}_${title.replace(/[^\w\s]/gi, '').substring(0, 30)}`;
            const filePath = path.join(this.tempDir, `${fileName}.${format === 'audio' ? 'mp3' : 'mp4'}`);

            if (format === 'audio') {
                const stream = ytdl(url, { quality: 'highestaudio', filter: 'audioonly' });
                stream.pipe(fs.createWriteStream(filePath));
                
                await new Promise((resolve, reject) => {
                    stream.on('end', resolve);
                    stream.on('error', reject);
                });

                await context.bot.sendMessage(context.sender, {
                    audio: { url: filePath },
                    mimetype: 'audio/mp4',
                    caption: `🎵 *${title}*\n\n📱 Downloaded via HyperWa`
                });
            } else {
                const stream = ytdl(url, { quality: 'highest', filter: 'videoandaudio' });
                stream.pipe(fs.createWriteStream(filePath));
                
                await new Promise((resolve, reject) => {
                    stream.on('end', resolve);
                    stream.on('error', reject);
                });

                await context.bot.sendMessage(context.sender, {
                    video: { url: filePath },
                    caption: `🎬 *${title}*\n\n📱 Downloaded via HyperWa`
                });
            }

            // Cleanup
            setTimeout(() => fs.remove(filePath), 300000); // Delete after 5 minutes

            return `✅ *Download Complete*\n\n🎬 Title: ${title}\n📁 Format: ${format.toUpperCase()}\n⏰ ${new Date().toLocaleTimeString()}`;

        } catch (error) {
            throw new Error(`YouTube download failed: ${error.message}`);
        }
    }

    async downloadInstagram(msg, params, context) {
        if (params.length === 0) {
            return '❌ *Instagram Downloader*\n\nPlease provide an Instagram URL.\n\n💡 Usage: `.igdl <url>`';
        }

        const url = params[0];
        
        if (!url.includes('instagram.com')) {
            return '❌ *Invalid Instagram URL*\n\nPlease provide a valid Instagram post/story/reel URL.';
        }

        try {
            // This is a placeholder - you'll need to implement actual Instagram API or use a service
            return '⚠️ *Instagram Download*\n\nInstagram downloading requires additional API setup.\nPlease configure Instagram API credentials in the module.';
        } catch (error) {
            throw new Error(`Instagram download failed: ${error.message}`);
        }
    }

    async downloadTikTok(msg, params, context) {
        if (params.length === 0) {
            return '❌ *TikTok Downloader*\n\nPlease provide a TikTok URL.\n\n💡 Usage: `.ttdl <url>`';
        }

        const url = params[0];
        
        if (!url.includes('tiktok.com')) {
            return '❌ *Invalid TikTok URL*\n\nPlease provide a valid TikTok video URL.';
        }

        try {
            // This is a placeholder - you'll need to implement actual TikTok API or use a service
            return '⚠️ *TikTok Download*\n\nTikTok downloading requires additional API setup.\nPlease configure TikTok API credentials in the module.';
        } catch (error) {
            throw new Error(`TikTok download failed: ${error.message}`);
        }
    }

    async destroy() {
        await fs.remove(this.tempDir);
        console.log('🛑 Downloader module destroyed');
    }
}

module.exports = DownloaderModule;