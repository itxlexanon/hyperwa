const logger = require('../Core/logger');

class TelegramCommands {
    constructor(bridge) {
        this.bridge = bridge;
        this.contactsPerPage = 50;
        this.userSessions = new Map(); // Store user session data
    }

    async handleCommand(msg) {
        const text = msg.text;
        if (!text || !text.startsWith('/')) return;

        const [command, ...args] = text.split(' ');

        try {
            switch (command.toLowerCase()) {
                case '/start':
                    await this.handleStart(msg.chat.id);
                    break;
                case '/status':
                    await this.handleStatus(msg.chat.id);
                    break;
                case '/send':
                    await this.handleSend(msg.chat.id, args);
                    break;
                case '/sync':
                    await this.handleSync(msg.chat.id);
                    break;
                case '/contacts':
                    await this.handleContacts(msg.chat.id, args);
                    break;
                case '/searchcontact':
                    await this.handleSearchContact(msg.chat.id, args);
                    break;
                case '/exportcontacts':
                    await this.handleExportContacts(msg.chat.id);
                    break;
                case '/updatetopics':
                    await this.handleUpdateTopics(msg.chat.id);
                    break;
                case '/forcecontactsync':
                    await this.handleForceContactSync(msg.chat.id);
                    break;
                case '/config':
                    await this.handleConfig(msg.chat.id, args);
                    break;
                default:
                    await this.handleMenu(msg.chat.id);
            }
        } catch (error) {
            logger.error(`❌ Error handling command ${command}:`, error);
            await this.bridge.telegramBot.sendMessage(
                msg.chat.id,
                `❌ Command error: ${error.message}`,
                { parse_mode: 'Markdown' }
            );
        }
    }

    async handleCallbackQuery(callbackQuery) {
        const data = callbackQuery.data;
        const chatId = callbackQuery.message.chat.id;
        const messageId = callbackQuery.message.message_id;

        try {
            if (data.startsWith('contacts_')) {
                await this.handleContactsPagination(chatId, messageId, data);
            } else if (data.startsWith('search_')) {
                await this.handleSearchPagination(chatId, messageId, data);
            } else if (data === 'sync') {
                await this.handleSync(chatId);
            } else if (data === 'status') {
                await this.handleStatus(chatId);
            } else if (data === 'update_topics') {
                await this.handleUpdateTopics(chatId);
            } else if (data === 'force_contact_sync') {
                await this.handleForceContactSync(chatId);
            } else if (data === 'export_contacts') {
                await this.handleExportContacts(chatId);
            } else if (data === 'search_help') {
                await this.bridge.telegramBot.sendMessage(chatId,
                    '🔍 *Search Contacts*\n\n' +
                    '*Usage:* `/searchcontact <name or phone>`\n\n' +
                    '*Examples:*\n' +
                    '`/searchcontact John`\n' +
                    '`/searchcontact 1234567890`\n' +
                    '`/searchcontact +1234`\n\n' +
                    '*Note:* Search is case-insensitive and matches partial names/numbers',
                    { parse_mode: 'Markdown' });
            } else if (data === 'menu') {
                await this.handleMenu(chatId);
            }

            // Answer the callback query to remove loading state
            await this.bridge.telegramBot.answerCallbackQuery(callbackQuery.id);
        } catch (error) {
            logger.error('❌ Error handling callback query:', error);
            await this.bridge.telegramBot.answerCallbackQuery(callbackQuery.id, {
                text: `❌ Error: ${error.message}`,
                show_alert: true
            });
        }
    }

    async handleContactsPagination(chatId, messageId, data) {
        const [, action, pageStr] = data.split('_');
        let page = parseInt(pageStr) || 0;

        if (action === 'next') page++;
        if (action === 'prev') page--;
        if (action === 'first') page = 0;

        await this.showContactsPage(chatId, messageId, page, true);
    }

    async handleSearchPagination(chatId, messageId, data) {
        const [, action, pageStr, ...queryParts] = data.split('_');
        const query = queryParts.join('_');
        let page = parseInt(pageStr) || 0;

        if (action === 'next') page++;
        if (action === 'prev') page--;
        if (action === 'first') page = 0;

        await this.showSearchResultsPage(chatId, messageId, page, query, true);
    }

    async handleStart(chatId) {
        const isReady = !!this.bridge.telegramBot;
        const welcome = `🤖 *WhatsApp-Telegram Bridge*\n\n` +
            `Status: ${isReady ? '✅ Ready' : '⏳ Initializing...'}\n` +
            `Linked Chats: ${this.bridge.chatMappings.size}\n` +
            `Contacts: ${this.bridge.contactMappings.size}\n` +
            `Users: ${this.bridge.userMappings.size}\n\n` +
            `Use /contacts to view your WhatsApp contacts\n` +
            `Use /menu to see all available commands`;
        
        await this.bridge.telegramBot.sendMessage(chatId, welcome, { 
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '📞 View Contacts', callback_data: 'contacts_first_0' },
                        { text: '📊 Status', callback_data: 'status' }
                    ],
                    [
                        { text: '🔄 Sync Contacts', callback_data: 'sync' },
                        { text: '📝 Update Topics', callback_data: 'update_topics' }
                    ],
                    [
                        { text: '🔧 Force Sync', callback_data: 'force_contact_sync' },
                        { text: '📋 Menu', callback_data: 'menu' }
                    ]
                ]
            }
        });
    }

    async handleStatus(chatId) {
        const whatsappStatus = this.bridge.whatsappBot?.sock ? '✅ Connected' : '❌ Disconnected';
        const userName = this.bridge.whatsappBot?.sock?.user?.name || 'Unknown';
        const userPhone = this.bridge.whatsappBot?.sock?.user?.id?.split('@')[0] || 'Unknown';
        
        const status = `📊 *Bridge Status*\n\n` +
            `🔗 WhatsApp: ${whatsappStatus}\n` +
            `👤 User: ${userName}\n` +
            `📱 Phone: +${userPhone}\n` +
            `💬 Active Chats: ${this.bridge.chatMappings.size}\n` +
            `👥 Users: ${this.bridge.userMappings.size}\n` +
            `📞 Contacts: ${this.bridge.contactMappings.size}\n` +
            `🖼️ Profile Pics Cached: ${this.bridge.profilePicCache.size}\n\n` +
            `⏰ Last Updated: ${new Date().toLocaleString()}`;
        
        await this.bridge.telegramBot.sendMessage(chatId, status, { 
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '🔄 Refresh', callback_data: 'status' },
                        { text: '📞 Contacts', callback_data: 'contacts_first_0' }
                    ],
                    [
                        { text: '📝 Update Topics', callback_data: 'update_topics' },
                        { text: '🔧 Force Sync', callback_data: 'force_contact_sync' }
                    ]
                ]
            }
        });
    }

    async handleSend(chatId, args) {
        if (args.length < 2) {
            await this.bridge.telegramBot.sendMessage(chatId,
                '❌ *Usage:* `/send <number> <message>`\n\n' +
                '*Examples:*\n' +
                '`/send 1234567890 Hello!`\n' +
                '`/send +1234567890 How are you?`\n\n' +
                '*Note:* You can use + prefix or country code',
                { parse_mode: 'Markdown' });
            return;
        }

        const number = args[0].replace(/[^\d]/g, ''); // Remove non-digits
        const message = args.slice(1).join(' ');

        if (number.length < 10) {
            await this.bridge.telegramBot.sendMessage(chatId,
                '❌ Invalid phone number. Please provide a valid number.',
                { parse_mode: 'Markdown' });
            return;
        }

        try {
            const jid = `${number}@s.whatsapp.net`;
            const result = await this.bridge.whatsappBot.sendMessage(jid, { text: message });
            
            const contactName = this.bridge.contactMappings.get(number) || `+${number}`;
            const statusText = result?.key?.id ? 
                `✅ Message sent to *${contactName}*\n\n📱 Number: +${number}\n💬 Message: "${message}"` : 
                `⚠️ Message sent to *${contactName}* but no confirmation received`;
            
            await this.bridge.telegramBot.sendMessage(chatId, statusText, { parse_mode: 'Markdown' });
        } catch (error) {
            await this.bridge.telegramBot.sendMessage(chatId, 
                `❌ *Error sending message:*\n${error.message}`, 
                { parse_mode: 'Markdown' });
        }
    }

    async handleSync(chatId) {
        const loadingMsg = await this.bridge.telegramBot.sendMessage(chatId, 
            '🔄 *Syncing contacts from WhatsApp...*\n\nThis may take a few moments...', 
            { parse_mode: 'Markdown' });

        try {
            const beforeCount = this.bridge.contactMappings.size;
            await this.bridge.syncContacts(true); // Force update
            const afterCount = this.bridge.contactMappings.size;
            const newContacts = afterCount - beforeCount;

            const successText = `✅ *Contact sync completed!*\n\n` +
                `📞 Total contacts: ${afterCount}\n` +
                `🆕 New contacts: ${newContacts >= 0 ? newContacts : 0}\n` +
                `🔄 Updated: ${new Date().toLocaleString()}`;

            await this.bridge.telegramBot.editMessageText(successText, {
                chat_id: chatId,
                message_id: loadingMsg.message_id,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '📞 View Contacts', callback_data: 'contacts_first_0' },
                            { text: '📝 Update Topics', callback_data: 'update_topics' }
                        ]
                    ]
                }
            });
        } catch (error) {
            await this.bridge.telegramBot.editMessageText(
                `❌ *Sync failed:*\n${error.message}`, {
                chat_id: chatId,
                message_id: loadingMsg.message_id,
                parse_mode: 'Markdown'
            });
        }
    }

    async handleForceContactSync(chatId) {
        const loadingMsg = await this.bridge.telegramBot.sendMessage(chatId, 
            '🔧 *Force syncing contacts from WhatsApp...*\n\nFetching from multiple sources...', 
            { parse_mode: 'Markdown' });

        try {
            const beforeCount = this.bridge.contactMappings.size;
            await this.bridge.forceContactSync(); // New method for force sync
            const afterCount = this.bridge.contactMappings.size;
            const newContacts = afterCount - beforeCount;

            const successText = `✅ *Force contact sync completed!*\n\n` +
                `📞 Total contacts: ${afterCount}\n` +
                `🆕 New contacts: ${newContacts >= 0 ? newContacts : 0}\n` +
                `🔄 Updated: ${new Date().toLocaleString()}`;

            await this.bridge.telegramBot.editMessageText(successText, {
                chat_id: chatId,
                message_id: loadingMsg.message_id,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '📞 View Contacts', callback_data: 'contacts_first_0' },
                            { text: '📝 Update Topics', callback_data: 'update_topics' }
                        ]
                    ]
                }
            });
        } catch (error) {
            await this.bridge.telegramBot.editMessageText(
                `❌ *Force sync failed:*\n${error.message}`, {
                chat_id: chatId,
                message_id: loadingMsg.message_id,
                parse_mode: 'Markdown'
            });
        }
    }

    async handleUpdateTopics(chatId) {
        const loadingMsg = await this.bridge.telegramBot.sendMessage(chatId, 
            '📝 *Updating topic names...*\n\nThis may take a few moments...', 
            { parse_mode: 'Markdown' });

        try {
            const updatedCount = await this.bridge.updateTopicNames();
            
            const successText = `✅ *Topic names updated!*\n\n` +
                `📝 Updated topics: ${updatedCount}\n` +
                `📞 Total contacts: ${this.bridge.contactMappings.size}\n` +
                `🔄 Updated: ${new Date().toLocaleString()}`;

            await this.bridge.telegramBot.editMessageText(successText, {
                chat_id: chatId,
                message_id: loadingMsg.message_id,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '📞 View Contacts', callback_data: 'contacts_first_0' },
                            { text: '📊 Status', callback_data: 'status' }
                        ]
                    ]
                }
            });
        } catch (error) {
            await this.bridge.telegramBot.editMessageText(
                `❌ *Topic update failed:*\n${error.message}`, {
                chat_id: chatId,
                message_id: loadingMsg.message_id,
                parse_mode: 'Markdown'
            });
        }
    }

    async handleConfig(chatId, args) {
        if (args.length === 0) {
            // Show current config
            const config = require('../config');
            const autoUpdateTopics = config.get('telegram.features.autoUpdateTopics') !== false;
            const autoUpdateContacts = config.get('telegram.features.autoUpdateContacts') !== false;
            const profilePicSync = config.get('telegram.features.profilePicSync') !== false;
            
            const configText = `⚙️ *Current Configuration*\n\n` +
                `📝 Auto Update Topics: ${autoUpdateTopics ? '✅ Enabled' : '❌ Disabled'}\n` +
                `📞 Auto Update Contacts: ${autoUpdateContacts ? '✅ Enabled' : '❌ Disabled'}\n` +
                `📸 Profile Pic Sync: ${profilePicSync ? '✅ Enabled' : '❌ Disabled'}\n\n` +
                `*Usage:*\n` +
                `\`/config auto_topics true/false\`\n` +
                `\`/config auto_contacts true/false\`\n` +
                `\`/config profile_pics true/false\``;

            await this.bridge.telegramBot.sendMessage(chatId, configText, { parse_mode: 'Markdown' });
            return;
        }

        if (args.length !== 2) {
            await this.bridge.telegramBot.sendMessage(chatId,
                '❌ *Usage:* `/config <setting> <true/false>`\n\n' +
                '*Available settings:*\n' +
                '• `auto_topics` - Auto update topic names\n' +
                '• `auto_contacts` - Auto update contacts\n' +
                '• `profile_pics` - Profile picture sync',
                { parse_mode: 'Markdown' });
            return;
        }

        const [setting, value] = args;
        const boolValue = value.toLowerCase() === 'true';
        const config = require('../config');

        try {
            switch (setting.toLowerCase()) {
                case 'auto_topics':
                    config.set('telegram.features.autoUpdateTopics', boolValue);
                    await this.bridge.telegramBot.sendMessage(chatId,
                        `✅ Auto update topics: ${boolValue ? 'Enabled' : 'Disabled'}`,
                        { parse_mode: 'Markdown' });
                    break;
                case 'auto_contacts':
                    config.set('telegram.features.autoUpdateContacts', boolValue);
                    await this.bridge.telegramBot.sendMessage(chatId,
                        `✅ Auto update contacts: ${boolValue ? 'Enabled' : 'Disabled'}`,
                        { parse_mode: 'Markdown' });
                    break;
                case 'profile_pics':
                    config.set('telegram.features.profilePicSync', boolValue);
                    await this.bridge.telegramBot.sendMessage(chatId,
                        `✅ Profile picture sync: ${boolValue ? 'Enabled' : 'Disabled'}`,
                        { parse_mode: 'Markdown' });
                    break;
                default:
                    await this.bridge.telegramBot.sendMessage(chatId,
                        '❌ Unknown setting. Available: auto_topics, auto_contacts, profile_pics',
                        { parse_mode: 'Markdown' });
            }
        } catch (error) {
            await this.bridge.telegramBot.sendMessage(chatId,
                `❌ Failed to update config: ${error.message}`,
                { parse_mode: 'Markdown' });
        }
    }

    async handleContacts(chatId, args) {
        const page = args.length > 0 ? parseInt(args[0]) || 0 : 0;
        await this.showContactsPage(chatId, null, page, false);
    }

    async showContactsPage(chatId, messageId = null, page = 0, isEdit = false) {
        try {
            const contacts = [...this.bridge.contactMappings.entries()];
            
            if (contacts.length === 0) {
                const noContactsText = '📞 *No contacts found*\n\nTry syncing your contacts first with /sync or /forcecontactsync';
                const options = { 
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '🔄 Sync Contacts', callback_data: 'sync' },
                                { text: '🔧 Force Sync', callback_data: 'force_contact_sync' }
                            ]
                        ]
                    }
                };

                if (isEdit && messageId) {
                    await this.bridge.telegramBot.editMessageText(noContactsText, {
                        chat_id: chatId,
                        message_id: messageId,
                        ...options
                    });
                } else {
                    await this.bridge.telegramBot.sendMessage(chatId, noContactsText, options);
                }
                return;
            }

            // Sort contacts alphabetically by name
            contacts.sort(([, nameA], [, nameB]) => {
                const a = (nameA || '').toLowerCase();
                const b = (nameB || '').toLowerCase();
                return a.localeCompare(b);
            });

            const totalPages = Math.ceil(contacts.length / this.contactsPerPage);
            const startIndex = page * this.contactsPerPage;
            const endIndex = Math.min(startIndex + this.contactsPerPage, contacts.length);
            const pageContacts = contacts.slice(startIndex, endIndex);

            let contactList = pageContacts.map((contact, index) => {
                const [phone, name] = contact;
                const displayName = name || 'Unknown';
                const globalIndex = startIndex + index + 1;
                return `${globalIndex}. 📱 *${displayName}*\n   📞 +${phone}`;
            }).join('\n\n');

            const headerText = `📞 *WhatsApp Contacts*\n\n` +
                `📊 Showing ${startIndex + 1}-${endIndex} of ${contacts.length} contacts\n` +
                `📄 Page ${page + 1} of ${totalPages}\n\n`;

            const fullText = headerText + contactList;

            // Create pagination buttons
            const keyboard = [];
            const navButtons = [];

            // Previous page button
            if (page > 0) {
                navButtons.push({ text: '⬅️ Previous', callback_data: `contacts_prev_${page}` });
            }

            // Page indicator
            if (totalPages > 1) {
                navButtons.push({ text: `${page + 1}/${totalPages}`, callback_data: 'noop' });
            }

            // Next page button
            if (page < totalPages - 1) {
                navButtons.push({ text: 'Next ➡️', callback_data: `contacts_next_${page}` });
            }

            if (navButtons.length > 0) {
                keyboard.push(navButtons);
            }

            // Action buttons
            const actionButtons = [];
            if (page > 0) {
                actionButtons.push({ text: '⏮️ First', callback_data: 'contacts_first_0' });
            }
            actionButtons.push({ text: '🔄 Sync', callback_data: 'sync' });
            actionButtons.push({ text: '🔍 Search', callback_data: 'search_help' });
            
            if (actionButtons.length > 0) {
                keyboard.push(actionButtons);
            }

            // Management buttons
            keyboard.push([
                { text: '📝 Update Topics', callback_data: 'update_topics' },
                { text: '🔧 Force Sync', callback_data: 'force_contact_sync' }
            ]);

            // Export button
            keyboard.push([{ text: '📤 Export All', callback_data: 'export_contacts' }]);

            const options = {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            };

            if (isEdit && messageId) {
                await this.bridge.telegramBot.editMessageText(fullText, {
                    chat_id: chatId,
                    message_id: messageId,
                    ...options
                });
            } else {
                await this.bridge.telegramBot.sendMessage(chatId, fullText, options);
            }

        } catch (error) {
            logger.error('❌ Failed to show contacts page:', error);
            const errorText = `❌ *Error loading contacts:*\n${error.message}`;
            
            if (isEdit && messageId) {
                await this.bridge.telegramBot.editMessageText(errorText, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown'
                });
            } else {
                await this.bridge.telegramBot.sendMessage(chatId, errorText, { parse_mode: 'Markdown' });
            }
        }
    }

    async handleSearchContact(chatId, args) {
        if (args.length < 1) {
            await this.bridge.telegramBot.sendMessage(chatId,
                '🔍 *Search Contacts*\n\n' +
                '*Usage:* `/searchcontact <name or phone>`\n\n' +
                '*Examples:*\n' +
                '`/searchcontact John`\n' +
                '`/searchcontact 1234567890`\n' +
                '`/searchcontact +1234`\n\n' +
                '*Note:* Search is case-insensitive and matches partial names/numbers',
                { parse_mode: 'Markdown' });
            return;
        }

        const query = args.join(' ').toLowerCase();
        await this.showSearchResultsPage(chatId, null, 0, query, false);
    }

    async showSearchResultsPage(chatId, messageId = null, page = 0, query, isEdit = false) {
        try {
            const allContacts = [...this.bridge.contactMappings.entries()];
            const matches = allContacts.filter(([phone, name]) =>
                name?.toLowerCase().includes(query) || 
                phone.includes(query.replace(/[^\d]/g, '')) // Remove non-digits for phone search
            );

            if (matches.length === 0) {
                const noResultsText = `🔍 *Search Results*\n\n❌ No contacts found for "*${query}*"\n\n` +
                    `Try searching with:\n• Full or partial name\n• Phone number\n• Country code`;
                
                const options = {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '📞 View All Contacts', callback_data: 'contacts_first_0' }]
                        ]
                    }
                };

                if (isEdit && messageId) {
                    await this.bridge.telegramBot.editMessageText(noResultsText, {
                        chat_id: chatId,
                        message_id: messageId,
                        ...options
                    });
                } else {
                    await this.bridge.telegramBot.sendMessage(chatId, noResultsText, options);
                }
                return;
            }

            // Sort matches alphabetically
            matches.sort(([, nameA], [, nameB]) => {
                const a = (nameA || '').toLowerCase();
                const b = (nameB || '').toLowerCase();
                return a.localeCompare(b);
            });

            const totalPages = Math.ceil(matches.length / this.contactsPerPage);
            const startIndex = page * this.contactsPerPage;
            const endIndex = Math.min(startIndex + this.contactsPerPage, matches.length);
            const pageMatches = matches.slice(startIndex, endIndex);

            let resultList = pageMatches.map((contact, index) => {
                const [phone, name] = contact;
                const displayName = name || 'Unknown';
                const globalIndex = startIndex + index + 1;
                
                // Highlight search term in name
                const highlightedName = name ? 
                    name.replace(new RegExp(`(${query})`, 'gi'), '*$1*') : 
                    'Unknown';
                
                return `${globalIndex}. 📱 ${highlightedName}\n   📞 +${phone}`;
            }).join('\n\n');

            const headerText = `🔍 *Search Results for "${query}"*\n\n` +
                `📊 Found ${matches.length} matches\n` +
                `📄 Showing ${startIndex + 1}-${endIndex} (Page ${page + 1}/${totalPages})\n\n`;

            const fullText = headerText + resultList;

            // Create pagination buttons for search results
            const keyboard = [];
            const navButtons = [];

            if (page > 0) {
                navButtons.push({ text: '⬅️ Previous', callback_data: `search_prev_${page}_${query}` });
            }

            if (totalPages > 1) {
                navButtons.push({ text: `${page + 1}/${totalPages}`, callback_data: 'noop' });
            }

            if (page < totalPages - 1) {
                navButtons.push({ text: 'Next ➡️', callback_data: `search_next_${page}_${query}` });
            }

            if (navButtons.length > 0) {
                keyboard.push(navButtons);
            }

            // Action buttons
            keyboard.push([
                { text: '📞 All Contacts', callback_data: 'contacts_first_0' },
                { text: '🔍 New Search', callback_data: 'search_help' }
            ]);

            const options = {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            };

            if (isEdit && messageId) {
                await this.bridge.telegramBot.editMessageText(fullText, {
                    chat_id: chatId,
                    message_id: messageId,
                    ...options
                });
            } else {
                await this.bridge.telegramBot.sendMessage(chatId, fullText, options);
            }

        } catch (error) {
            logger.error('❌ Failed to show search results:', error);
            const errorText = `❌ *Search error:*\n${error.message}`;
            
            if (isEdit && messageId) {
                await this.bridge.telegramBot.editMessageText(errorText, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown'
                });
            } else {
                await this.bridge.telegramBot.sendMessage(chatId, errorText, { parse_mode: 'Markdown' });
            }
        }
    }

    async handleExportContacts(chatId) {
        try {
            const contacts = [...this.bridge.contactMappings.entries()];
            
            if (contacts.length === 0) {
                await this.bridge.telegramBot.sendMessage(chatId, 
                    '📞 No contacts to export. Sync your contacts first with /sync',
                    { parse_mode: 'Markdown' });
                return;
            }

            // Sort contacts alphabetically
            contacts.sort(([, nameA], [, nameB]) => {
                const a = (nameA || '').toLowerCase();
                const b = (nameB || '').toLowerCase();
                return a.localeCompare(b);
            });

            // Create CSV content
            let csvContent = 'Name,Phone,WhatsApp ID\n';
            contacts.forEach(([phone, name]) => {
                const displayName = (name || 'Unknown').replace(/"/g, '""'); // Escape quotes
                csvContent += `"${displayName}","+${phone}","${phone}@s.whatsapp.net"\n`;
            });

            // Create text content
            let textContent = `📞 WhatsApp Contacts Export\n`;
            textContent += `📅 Generated: ${new Date().toLocaleString()}\n`;
            textContent += `📊 Total Contacts: ${contacts.length}\n\n`;
            textContent += `${'='.repeat(50)}\n\n`;
            
            contacts.forEach(([phone, name], index) => {
                textContent += `${index + 1}. ${name || 'Unknown'}\n`;
                textContent += `   📞 +${phone}\n`;
                textContent += `   💬 ${phone}@s.whatsapp.net\n\n`;
            });

            // Send as document
            const fileName = `whatsapp_contacts_${new Date().toISOString().split('T')[0]}.txt`;
            const buffer = Buffer.from(textContent, 'utf8');

            await this.bridge.telegramBot.sendDocument(chatId, buffer, {
                filename: fileName,
                caption: `📤 *WhatsApp Contacts Export*\n\n📊 ${contacts.length} contacts exported\n📅 ${new Date().toLocaleString()}`,
                parse_mode: 'Markdown'
            });

        } catch (error) {
            logger.error('❌ Failed to export contacts:', error);
            await this.bridge.telegramBot.sendMessage(chatId, 
                `❌ *Export failed:*\n${error.message}`, 
                { parse_mode: 'Markdown' });
        }
    }

    async handleMenu(chatId) {
        const message = `📋 *Available Commands*\n\n` +
            `🤖 \`/start\` - Show bot info and quick actions\n` +
            `📊 \`/status\` - Show detailed bridge status\n` +
            `📞 \`/contacts [page]\` - View WhatsApp contacts\n` +
            `🔍 \`/searchcontact <query>\` - Search contacts\n` +
            `📤 \`/exportcontacts\` - Export all contacts\n` +
            `💬 \`/send <number> <message>\` - Send WhatsApp message\n` +
            `🔄 \`/sync\` - Sync WhatsApp contacts\n` +
            `🔧 \`/forcecontactsync\` - Force sync from all sources\n` +
            `📝 \`/updatetopics\` - Update all topic names\n` +
            `⚙️ \`/config\` - View/change configuration\n\n` +
            `*Examples:*\n` +
            `\`/contacts 2\` - View page 2 of contacts\n` +
            `\`/searchcontact John\` - Find contacts named John\n` +
            `\`/send 1234567890 Hello!\` - Send message\n` +
            `\`/config auto_topics true\` - Enable auto topic updates`;

        await this.bridge.telegramBot.sendMessage(chatId, message, { 
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '📞 Contacts', callback_data: 'contacts_first_0' },
                        { text: '📊 Status', callback_data: 'status' }
                    ],
                    [
                        { text: '🔄 Sync', callback_data: 'sync' },
                        { text: '📝 Update Topics', callback_data: 'update_topics' }
                    ],
                    [
                        { text: '🔧 Force Sync', callback_data: 'force_contact_sync' },
                        { text: '🔍 Search', callback_data: 'search_help' }
                    ]
                ]
            }
        });
    }

    async registerBotCommands() {
        try {
            await this.bridge.telegramBot.setMyCommands([
                { command: 'start', description: 'Show bot info and quick actions' },
                { command: 'status', description: 'Show detailed bridge status' },
                { command: 'contacts', description: 'View WhatsApp contacts (paginated)' },
                { command: 'searchcontact', description: 'Search WhatsApp contacts' },
                { command: 'exportcontacts', description: 'Export all contacts as file' },
                { command: 'send', description: 'Send WhatsApp message' },
                { command: 'sync', description: 'Sync WhatsApp contacts' },
                { command: 'forcecontactsync', description: 'Force sync contacts from all sources' },
                { command: 'updatetopics', description: 'Update all topic names manually' },
                { command: 'config', description: 'View/change bot configuration' },
                { command: 'menu', description: 'Show all available commands' }
            ]);
            logger.info('✅ Telegram bot commands registered');
        } catch (error) {
            logger.error('❌ Failed to register Telegram bot commands:', error);
        }
    }

    // Setup callback query handler in bridge
    setupCallbackHandler() {
        if (this.bridge.telegramBot) {
            this.bridge.telegramBot.on('callback_query', async (callbackQuery) => {
                await this.handleCallbackQuery(callbackQuery);
            });
            logger.info('✅ Callback query handler set up');
        }
    }
}

module.exports = TelegramCommands;
