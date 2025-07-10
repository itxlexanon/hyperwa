const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { tmpdir } = require('os');

module.exports = {
    name: 'rvo',
    metadata: {
        version: '1.1.0',
        description: 'Extract and reveal view-once media (image, video, audio)',
        author: 'Ported from Neoxr by Dawium',
        category: 'Media'
    },
    commands: [
        {
            name: 'rvo',
            description: 'Reveal view-once media by replying to it',
            usage: '.rvo (reply to view-once media)',
            permissions: 'owner',
            async execute(msg, params, { bot, sender }) {
                const ctx = msg.message?.extendedTextMessage?.contextInfo;
                const quoted = ctx?.quotedMessage;
                const stanzaId = ctx?.stanzaId;
                const participant = ctx?.participant;
                const remoteJid = msg.key.remoteJid;

                if (!quoted) {
                    return bot.sendMessage(sender, { text: '⚠️ Please reply to a view-once media message.' });
                }

                const type = Object.keys(quoted)?.[0];
                const mediaMsg = quoted[type];

                if (!/image|video|audio/.test(type)) {
                    return bot.sendMessage(sender, { text: '❌ Unsupported media type or not a view-once message.' });
                }

                // Reconstruct minimal message object
                const fakeMsg = {
                    key: {
                        remoteJid,
                        fromMe: false,
                        id: stanzaId,
                        participant
                    },
                    message: {
                        [type]: mediaMsg
                    }
                };

                try {
                    const buffer = await bot.sock.downloadMediaMessage(fakeMsg);

                    if (type === 'audio') {
                        const inputPath = path.join(tmpdir(), `rvo-${Date.now()}.ogg`);
                        const outputPath = path.join(tmpdir(), `rvo-${Date.now()}.mp3`);
                        fs.writeFileSync(inputPath, buffer);

                        exec(`ffmpeg -i "${inputPath}" -vn -ar 44100 -ac 2 -b:a 128k "${outputPath}"`, async (err) => {
                            fs.unlinkSync(inputPath);
                            if (err) {
                                return bot.sendMessage(sender, { text: '❌ Audio conversion failed.' });
                            }
                            const mp3 = fs.readFileSync(outputPath);
                            fs.unlinkSync(outputPath);
                            await bot.sendMessage(sender, { audio: mp3, mimetype: 'audio/mp4' });
                        });
                    } else {
                        const content = {};
                        if (type === 'image') {
                            content.image = buffer;
                            content.caption = mediaMsg.caption || '👁️ ViewOnce Image';
                        } else if (type === 'video') {
                            content.video = buffer;
                            content.caption = mediaMsg.caption || '🎥 ViewOnce Video';
                        }
                        await bot.sendMessage(sender, content);
                    }
                } catch (e) {
                    return bot.sendMessage(sender, { text: `❌ Failed to download media.\n${e.message}` });
                }
            }
        }
    ]
};
