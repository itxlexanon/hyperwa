const logger = require('../Core/logger');
const config = require('../config');

/**
 * Utility class providing helper functions for bot operations.
 */
class Helpers {
    /**
     * Handles command execution with smart error handling and reactions.
     * Sends a ⏳ reaction at the start and removes it after completion or error.
     * @param {Object} bot - The bot instance with sock for sending messages.
     * @param {Object} originalMsg - The original message object.
     * @param {Object} [options={}] - Options for processing text, error text, and action function.
     * @returns {Promise<*>} The result of the action function or throws an error.
     */
    static async smartErrorRespond(bot, originalMsg, options = {}) {
        const {
            processingText = '⏳ Processing...',
            errorText = '❌ Something went wrong.',
            actionFn = () => { throw new Error('No action provided'); },
            autoReact = config.get('features.autoReact', true),
            editMessages = config.get('features.editMessages', true)
        } = options;

        // Validate inputs
        if (!bot?.sock?.sendMessage) {
            logger.error('Invalid bot instance in smartErrorRespond', { bot });
            throw new Error('Invalid bot instance');
        }
        if (!originalMsg?.key?.remoteJid || !originalMsg?.key?.id) {
            logger.error('Invalid message key in smartErrorRespond', { key: originalMsg?.key });
            throw new Error('Invalid message key');
        }

        const sender = originalMsg.key.remoteJid;
        let processingMsgKey = null;

        // Log for debugging
        logger.debug(`smartErrorRespond: autoReact=${autoReact}, editMessages=${editMessages}, command=${originalMsg.message?.conversation || 'unknown'}`);

        try {
            // 1. Send ⏳ reaction
            if (autoReact) {
                try {
                    await bot.sock.sendMessage(sender, {
                        react: { key: originalMsg.key, text: '⏳' }
                    });
                    logger.debug('Processing reaction (⏳) sent');
                } catch (reactError) {
                    logger.debug('Failed to send processing reaction:', reactError);
                    await bot.sendMessage(sender, { text: '⏳ Command processing started...' });
                }
            }

            // 2. Send processing message
            if (editMessages) {
                try {
                    const processingMsg = await bot.sendMessage(sender, { text: processingText });
                    processingMsgKey = processingMsg.key;
                    logger.debug('Processing message sent:', processingText);
                } catch (sendError) {
                    logger.debug('Failed to send processing message:', sendError);
                }
            }

            // 3. Execute the action
            const result = await actionFn();

            // 4. Remove reaction
            if (autoReact) {
                try {
                    await bot.sock.sendMessage(sender, {
                        react: { key: originalMsg.key, text: '' }
                    });
                    logger.debug('Reaction removed');
                } catch (reactError) {
                    logger.debug('Failed to remove reaction:', reactError);
                }
            }

            // 5. Handle result
            if (processingMsgKey && result && typeof result === 'string') {
                try {
                    await bot.sock.sendMessage(sender, {
                        text: result,
                        edit: processingMsgKey
                    });
                    logger.debug('Processing message edited with result:', result.substring(0, 50));
                } catch (editError) {
                    logger.debug('Failed to edit processing message:', editError);
                    await bot.sendMessage(sender, { text: result });
                }
            } else if (processingMsgKey && !result) {
                try {
                    await bot.sock.sendMessage(sender, {
                        text: '✅ Command completed successfully!',
                        edit: processingMsgKey
                    });
                    logger.debug('Processing message edited with success');
                } catch (editError) {
                    logger.debug('Failed to edit processing message:', editError);
                }
            } else if (result && typeof result === 'string') {
                await bot.sendMessage(sender, { text: result });
                logger.debug('Result sent as new message:', result.substring(0, 50));
            }

            return result;

        } catch (error) {
            logger.error('Error in smartErrorRespond:', {
                errorMessage: error.message,
                stack: error.stack,
                command: originalMsg.message?.conversation || 'unknown'
            });

            // Remove reaction on error
            if (autoReact) {
                try {
                    await bot.sock.sendMessage(sender, {
                        react: { key: originalMsg.key, text: '' }
                    });
                    logger.debug('Reaction removed on error');
                } catch (reactError) {
                    logger.debug('Failed to remove reaction on error:', reactError);
                }
            }

            // Handle error message
            const finalErrorText = error.message.includes('Unknown command') 
                ? errorText 
                : `${errorText}\n\n🔍 Error: ${error.message}`;

            if (processingMsgKey) {
                try {
                    await bot.sock.sendMessage(sender, {
                        text: finalErrorText,
                        edit: processingMsgKey
                    });
                    logger.debug('Processing message edited with error:', finalErrorText.substring(0, 50));
                } catch (editError) {
                    logger.debug('Failed to edit processing message with error:', editError);
                    await bot.sendMessage(sender, { text: finalErrorText });
                }
            } else {
                await bot.sendMessage(sender, { text: finalErrorText });
                logger.debug('Error message sent:', finalErrorText.substring(0, 50));
            }

            throw error;
        }
    }

    /**
     * Sends a command response with ⏳ reaction and unreact, for cases like unknown commands.
     * @param {Object} bot - The bot instance.
     * @param {Object} originalMsg - The original message object.
     * @param {string} responseText - The response text to send.
     * @returns {Promise<void>}
     */
    static async sendCommandResponse(bot, originalMsg, responseText) {
        await this.smartErrorRespond(bot, originalMsg, {
            processingText: '⏳ Checking command...',
            errorText: responseText,
            actionFn: async () => {
                throw new Error(responseText);
            }
        });
    }

    /**
     * Formats uptime from a start timestamp.
     * @param {number} startTime - Start time in milliseconds.
     * @returns {string} Formatted uptime (e.g., "2d 3h 15m 45s").
     */
    static formatUptime(startTime) {
        if (!startTime || typeof startTime !== 'number') {
            logger.warn('Invalid startTime in formatUptime:', startTime);
            return '0s';
        }
        const seconds = Math.floor((Date.now() - startTime) / 1000);
        if (seconds <= 0) return '0s';
        const days = Math.floor(seconds / (3600 * 24));
        const hours = Math.floor((seconds % (3600 * 24)) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;
        const parts = [];
        if (days > 0) parts.push(`${days}d`);
        if (hours > 0) parts.push(`${hours}h`);
        if (minutes > 0) parts.push(`${minutes}m`);
        if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
        return parts.join(' ');
    }

    /**
     * Formats a file size in bytes.
     * @param {number} bytes - Size in bytes.
     * @returns {string} Formatted file size (e.g., "1.23 MB").
     */
    static formatFileSize(bytes) {
        if (!bytes || typeof bytes !== 'number' || bytes < 0) {
            logger.warn('Invalid bytes in formatFileSize:', bytes);
            return '0 Bytes';
        }
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
    }

    /**
     * Cleans a phone number by removing non-digits.
     * @param {string} phone - Phone number to clean.
     * @returns {string} Cleaned phone number.
     */
    static cleanPhoneNumber(phone) {
        if (!phone || typeof phone !== 'string') {
            logger.warn('Invalid phone number in cleanPhoneNumber:', phone);
            return '';
        }
        return phone.replace(/[^\d]/g, '');
    }

    /**
     * Checks if a participant is the bot owner.
     * @param {string} participant - Participant's ID.
     * @returns {boolean} True if participant is the owner.
     */
    static isOwner(participant) {
        const owner = config.get('bot.owner');
        if (!owner) {
            logger.warn('Bot owner not configured');
            return false;
        }
        return participant === owner;
    }

    /**
     * Generates a random string.
     * @param {number} [length=8] - Length of the string.
     * @returns {string} Random string.
     */
    static generateRandomString(length = 8) {
        if (typeof length !== 'number' || length < 1) {
            logger.warn('Invalid length in generateRandomString:', length);
            length = 8;
        }
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let result = '';
        for (let i = 0; i < length; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }

    /**
     * Pauses execution for a duration.
     * @param {number} ms - Milliseconds to sleep.
     * @returns {Promise<void>} Resolves after the specified time.
     */
    static sleep(ms) {
        if (typeof ms !== 'number' || ms < 0) {
            logger.warn('Invalid ms in sleep:', ms);
            ms = 0;
        }
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = Helpers;
