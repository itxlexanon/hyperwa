async execute(msg, params, { bot, sender }) {
    const ctx = msg.message?.extendedTextMessage?.contextInfo;
    const quoted = ctx?.quotedMessage;
    const stanzaId = ctx?.stanzaId;
    const participant = ctx?.participant;
    const remoteJid = msg.key.remoteJid;

    if (!quoted) {
        return bot.sendMessage(sender, { text: '⚠️ Please reply to a view-once image, video, or audio.' });
    }

    // Build a complete "fake" message object from the quote
    const fakeMsg = {
        key: {
            remoteJid,
            fromMe: false,
            id: stanzaId,
            participant
        },
        message: {}
    };

    // Try wrapping it correctly based on type
    if (quoted?.imageMessage) {
        fakeMsg.message.viewOnceMessage = { message: { imageMessage: quoted.imageMessage } };
    } else if (quoted?.videoMessage) {
        fakeMsg.message.viewOnceMessage = { message: { videoMessage: quoted.videoMessage } };
    } else if (quoted?.audioMessage) {
        fakeMsg.message.viewOnceMessage = { message: { audioMessage: quoted.audioMessage } };
    } else {
        return bot.sendMessage(sender, { text: '❌ This is not a supported view-once media type.' });
    }

    const { ViewOnceHandler } = require('../Core/vo');
    const handler = new ViewOnceHandler(bot.sock, {
        autoForward: false,
        saveToTemp: false
    });

    if (!handler.isViewOnceMessage(fakeMsg)) {
        return bot.sendMessage(sender, { text: '❌ Still not detected as ViewOnce message.' });
    }

    const result = await handler.handleViewOnceMessage(fakeMsg);
    if (!result?.mediaData) {
        return bot.sendMessage(sender, { text: '⚠️ Failed to extract view-once media.' });
    }

    const { type, buffer, caption, mimetype } = result.mediaData;

    if (type === 'audio') {
        const fs = require('fs');
        const path = require('path');
        const { tmpdir } = require('os');
        const { exec } = require('child_process');

        const inputPath = path.join(tmpdir(), `vo-${Date.now()}.ogg`);
        const outputPath = path.join(tmpdir(), `vo-${Date.now()}.mp3`);
        fs.writeFileSync(inputPath, buffer);

        exec(`ffmpeg -i "${inputPath}" -vn -ar 44100 -ac 2 -b:a 128k "${outputPath}"`, async (err) => {
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
    } else {
        const content = {};
        if (type === 'image') {
            content.image = buffer;
            content.caption = caption || '👁️ Revealed ViewOnce Image';
        } else if (type === 'video') {
            content.video = buffer;
            content.caption = caption || '🎥 Revealed ViewOnce Video';
        }

        await bot.sendMessage(sender, content);
    }
}
