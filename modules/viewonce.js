const { ViewOnceHandler } = require('../Core/vo');

module.exports = {
    name: 'viewonce',
    metadata: {
        version: '1.0.0',
        description: 'Handle and control view-once media (auto forwarding, reveal)',
        author: 'Dawium AI',
        category: 'Media'
    },
    commands: [
        {
            name: 'viewonce',
            description: 'Toggle view-once forwarding (on/off)',
            usage: '.viewonce on|off',
            permissions: 'owner',
            async execute(msg, params, { bot, sender }) {
                const arg = (params[0] || '').toLowerCase();
                const handler = bot.messageHandler.viewOnceHandler;

                if (!handler) {
                    return bot.sendMessage(sender, { text: '❌ ViewOnce handler not initialized.' });
                }

                if (arg === 'on') {
                    handler.updateConfig({
                        autoForward: true,
                        forwardTarget: bot.sock.user.id
                    });
                    return bot.sendMessage(sender, { text: '✅ ViewOnce forwarding enabled to owner.' });
                }

                if (arg === 'off') {
                    handler.updateConfig({ autoForward: false });
                    return bot.sendMessage(sender, { text: '⛔ ViewOnce forwarding disabled.' });
                }

                return bot.sendMessage(sender, {
                    text: '❓ Usage:\n• `.viewonce on`\n• `.viewonce off`'
                });
            }
        },
        {
            name: 'v',
            description: 'Reveal view-once message (must reply to message)',
            usage: '.v (in reply to a view-once message)',
            permissions: 'owner',
            async execute(msg, params, { bot, sender }) {
                const handler = bot.messageHandler.viewOnceHandler;

                if (!handler) {
                    return bot.sendMessage(sender, { text: '❌ ViewOnce handler not initialized.' });
                }

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
            }
        }
    ]
};
