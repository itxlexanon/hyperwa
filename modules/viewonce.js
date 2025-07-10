const ctx = msg.message?.extendedTextMessage?.contextInfo;
const quoted = ctx?.quotedMessage;
const quotedParticipant = ctx?.participant;
const quotedStanzaId = ctx?.stanzaId;
const quotedJid = msg.key.remoteJid;

if (!quoted) {
    return bot.sendMessage(sender, { text: '⚠️ Please reply to a ViewOnce message.' });
}

const fakeMsg = {
    key: {
        remoteJid: quotedJid,
        fromMe: false,
        id: quotedStanzaId,
        participant: quotedParticipant
    },
    message: quoted
};

if (!handler.isViewOnceMessage(fakeMsg)) {
    return bot.sendMessage(sender, { text: '❌ That is not a ViewOnce message.' });
}

const result = await handler.handleViewOnceMessage(fakeMsg);
if (!result?.mediaData) {
    return bot.sendMessage(sender, { text: '⚠️ Failed to extract view-once media.' });
}

const content = {};
switch (result.mediaData.type) {
    case 'image':
        content.image = result.mediaData.buffer;
        content.caption = '👁️ ViewOnce Revealed';
        break;
    case 'video':
        content.video = result.mediaData.buffer;
        content.caption = '🎥 ViewOnce Revealed';
        break;
    case 'audio':
        content.audio = result.mediaData.buffer;
        content.mimetype = result.mediaData.mimetype || 'audio/mp4';
        break;
}

await bot.sendMessage(sender, content);
