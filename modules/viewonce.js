const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { tmpdir } = require('os');

module.exports = {
    name: 'rvo',
    metadata: {
        version: '1.0.0',
        description: 'Download view-once media from a replied message',
        author: 'You',
        category: 'Media'
    },
    commands: [
        {
            name: 'rvo',
            description: 'Download and show replied view-once media',
            usage: '.rvo (in reply)',
            permissions: 'owner',
            async execute(msg, params, { bot, sender }) {
                const ctx = msg.message?.extendedTextMessage?.contextInfo;
                const quoted = ctx?.quotedMessage;
                const stanzaId = ctx?.stanzaId;
                const participant = ctx?.participant;
                const remoteJid = msg.key.remoteJid;

                if (!quoted) {
                    return bot.sendMessage(sender, { text: '⚠️ Please reply to a ViewOnce message.' });
                }

                const fakeMsg = {
                    key: {
                        remoteJid,
                        fromMe: false,
                        id: stanzaId,
                        participant
                    },
                    message: quoted
                };

                const { ViewOnceHandler } = require('../Core/vo');
                const handler = new ViewOnceHandler(bot.sock, {
                    autoForward: false,
                    saveToTemp: false
                });

                if (!handler.isViewOnceMessage(fakeMsg)) {
                    return bot.sendMessage(sender, { text: '❌ Not a ViewOnce message.' });
                }

                const result = await handler.handleViewOnceMessage(fakeMsg);
                if (!result?.mediaData) {
                    return bot.sendMessage(sender, { text: '⚠️ Failed to extract view-once media.' });
                }

                const type = result.mediaData.type;
                const buffer = result.mediaData.buffer;
                const caption = result.mediaData.caption || '👁️ ViewOnce Media';

                // Audio conversion
                if (type === 'audio') {
                    const inputPath = path.join(tmpdir(), `vo-${Date.now()}.ogg`);
                    const outputPath = path.join(tmpdir(), `vo-${Date.now()}.mp3`);

                    fs.writeFileSync(inputPath, buffer);

                    exec(`ffmpeg -i ${inputPath} -vn -ar 44100 -ac 2 -b:a 128k ${outputPath}`, async (err) => {
                        fs.unlinkSync(inputPath);
                        if (err) {
                            return bot.sendMessage(sender, { text: '❌ Audio conversion failed.' });
                        }

                        const converted = fs.readFileSync(outputPath);
                        fs.unlinkSync(outputPath);

                        await bot.sendMessage(sender, {
                            audio: converted,
                            mimetype: 'audio/mp4'
                        });
                    });
                }

                // Image / video
                else {
                    const content = {};
                    if (type === 'image') {
                        content.image = buffer;
                        content.caption = caption;
                    } else if (type === 'video') {
                        content.video = buffer;
                        content.caption = caption;
                    }

                    await bot.sendMessage(sender, content);
                }
            }
        }
    ]
};
