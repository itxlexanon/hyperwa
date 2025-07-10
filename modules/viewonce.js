const { ViewOnceHandler } = require('../Core/vo');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { tmpdir } = require('os');

module.exports = {
    name: 'rvo',
    metadata: {
        version: '1.0.0',
        description: 'Download replied view-once image/video/audio',
        author: 'Dawium',
        category: 'Media'
    },
    commands: [
        {
            name: 'rvo',
            description: 'Reveal view-once media by replying to it',
            usage: '.rvo (reply to view-once)',
            permissions: 'owner',
            async execute(msg, params, { bot, sender }) {
                const ctx = msg.message?.extendedTextMessage?.contextInfo;
                const quoted = ctx?.quotedMessage;
                const stanzaId = ctx?.stanzaId;
                const participant = ctx?.participant;
                const remoteJid = msg.key.remoteJid;

                if (!quoted) {
                    return bot.sendMessage(sender, { text: '⚠️ Please reply to a view-once image/video/audio message.' });
                }

                // Create a fake view-once message wrapper
                const fakeMsg = {
                    key: {
                        remoteJid,
                        fromMe: false,
                        id: stanzaId,
                        participant
                    },
                    message: {}
                };

                // Wrap based on message type
                if (quoted?.imageMessage) {
                    fakeMsg.message.viewOnceMessage = { message: { imageMessage: quoted.imageMessage } };
                } else if (quoted?.videoMessage) {
                    fakeMsg.message.viewOnceMessage = { message: { videoMessage: quoted.videoMessage } };
                } else if (quoted?.audioMessage) {
                    fakeMsg.message.viewOnceMessage = { message: { audioMessage: quoted.audioMessage } };
                } else {
                    return bot.sendMessage(sender, { text: '❌ Unsupported or missing view-once content.' });
                }

                // Use existing handler (already working from your `vo.js`)
                const handler = new ViewOnceHandler(bot.sock, {
                    autoForward: false,
                    saveToTemp: false
                });

                const result = await handler.handleViewOnceMessage(fakeMsg);
                if (!result?.mediaData) {
                    return bot.sendMessage(sender, { text: '❌ Failed to extract media from view-once message.' });
                }

                const { type, buffer, caption, mimetype } = result.mediaData;

                // Convert audio if needed
                if (type === 'audio') {
                    const inputPath = path.join(tmpdir(), `rvo-${Date.now()}.ogg`);
                    const outputPath = path.join(tmpdir(), `rvo-${Date.now()}.mp3`);
                    fs.writeFileSync(inputPath, buffer);

                    exec(`ffmpeg -i "${inputPath}" -vn -ar 44100 -ac 2 -b:a 128k "${outputPath}"`, async (err) => {
                        fs.unlinkSync(inputPath);
                        if (err) {
                            return bot.sendMessage(sender, { text: '❌ Audio conversion failed.' });
                        }
                        const mp3Buffer = fs.readFileSync(outputPath);
                        fs.unlinkSync(outputPath);
                        await bot.sendMessage(sender, { audio: mp3Buffer, mimetype: 'audio/mp4' });
                    });
                } else {
                    const content = {};
                    if (type === 'image') {
                        content.image = buffer;
                        content.caption = caption || '👁️ ViewOnce Image';
                    } else if (type === 'video') {
                        content.video = buffer;
                        content.caption = caption || '🎥 ViewOnce Video';
                    }
                    await bot.sendMessage(sender, content);
                }
            }
        }
    ]
};
