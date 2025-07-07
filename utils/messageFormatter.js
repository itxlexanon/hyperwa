class MessageFormatter {
    static success(title, content, details = {}) {
        let message = `✅ *${title}*\n\n`;
        
        if (typeof content === 'string') {
            message += `${content}\n\n`;
        } else if (typeof content === 'object') {
            Object.entries(content).forEach(([key, value]) => {
                message += `📋 **${key}:** ${value}\n`;
            });
            message += '\n';
        }
        
        if (details.timestamp !== false) {
            message += `⏰ ${new Date().toLocaleTimeString()}`;
        }
        
        return message;
    }
    
    static error(title, error, suggestion = null) {
        let message = `❌ *${title}*\n\n`;
        message += `🚫 Error: ${error}\n\n`;
        
        if (suggestion) {
            message += `💡 Suggestion: ${suggestion}\n\n`;
        }
        
        message += `⏰ ${new Date().toLocaleTimeString()}`;
        return message;
    }
    
    static processing(title, steps = []) {
        let message = `⏳ *${title}*\n\n`;
        
        steps.forEach((step, index) => {
            message += `${index + 1}. ${step}\n`;
        });
        
        message += `\n🔄 Please wait...`;
        return message;
    }
    
    static info(title, data, options = {}) {
        let message = `ℹ️ *${title}*\n\n`;
        
        if (Array.isArray(data)) {
            data.forEach((item, index) => {
                message += `${options.numbered ? `${index + 1}. ` : '• '}${item}\n`;
            });
        } else if (typeof data === 'object') {
            Object.entries(data).forEach(([key, value]) => {
                const icon = options.icons?.[key] || '📋';
                message += `${icon} **${key}:** ${value}\n`;
            });
        } else {
            message += `${data}\n`;
        }
        
        if (options.footer !== false) {
            message += `\n⏰ ${new Date().toLocaleTimeString()}`;
        }
        
        return message;
    }
    
    static helpMenu(botName, prefix, stats) {
        return `🤖 *${botName} Help*\n\n` +
               `🎯 Prefix: \`${prefix}\`\n` +
               `📊 ${stats.modules} modules • ${stats.commands} commands\n\n` +
               `💡 *Quick Commands:*\n` +
               `• \`${prefix}help <module>\` - Module details\n` +
               `• \`${prefix}modules\` - List all modules\n` +
               `• \`${prefix}status\` - Bot status\n\n` +
               `📋 *Categories:*\n` +
               `🔧 System • 🎨 Media • 🌐 Utility\n` +
               `🎵 Entertainment • 🔒 Security\n\n` +
               `Type \`${prefix}help <category>\` to explore!`;
    }
    
    static moduleHelp(moduleName, metadata, commands, isSystem) {
        let message = `📦 *${moduleName}*\n\n`;
        
        // Module info
        message += `📝 ${metadata.description || 'No description'}\n`;
        message += `🆚 v${metadata.version || '1.0.0'} by ${metadata.author || 'Unknown'}\n`;
        message += `📂 ${metadata.category || 'Uncategorized'} • ${isSystem ? 'System' : 'Custom'}\n\n`;
        
        // Commands
        if (commands && commands.length > 0) {
            message += `⚡ *Commands (${commands.length}):*\n\n`;
            commands.forEach(cmd => {
                const permIcon = cmd.permissions === 'owner' ? '👑' : 
                               cmd.permissions === 'admin' ? '🛡️' : '🌐';
                message += `${permIcon} \`${cmd.name}\`\n`;
                message += `   ${cmd.description}\n`;
                message += `   📝 \`${cmd.usage}\`\n\n`;
            });
        } else {
            message += `⚡ *Commands:* None\n\n`;
        }
        
        return message;
    }
    
    static categoryHelp(category, modules, prefix) {
        const categoryIcons = {
            'system': '🔧',
            'media': '🎨', 
            'utility': '🌐',
            'entertainment': '🎵',
            'security': '🔒',
            'information': 'ℹ️',
            'ai': '🤖'
        };
        
        const icon = categoryIcons[category.toLowerCase()] || '📦';
        let message = `${icon} *${category.charAt(0).toUpperCase() + category.slice(1)} Modules*\n\n`;
        
        if (modules.length === 0) {
            message += `No modules in this category.\n\n`;
        } else {
            modules.forEach(mod => {
                const commandCount = mod.commands ? mod.commands.length : 0;
                message += `📦 **${mod.name}**\n`;
                message += `   ${mod.metadata?.description || 'No description'}\n`;
                message += `   ⚡ ${commandCount} commands\n\n`;
            });
        }
        
        message += `💡 Use \`${prefix}help <module>\` for details`;
        return message;
    }
    
    static moduleList(systemModules, customModules) {
        let message = `📋 *Loaded Modules*\n\n`;
        
        // System modules
        message += `🔧 *System (${systemModules.length}):*\n`;
        if (systemModules.length > 0) {
            systemModules.forEach(mod => {
                const cmdCount = mod.commands ? mod.commands.length : 0;
                message += `• ${mod.name} (${cmdCount})\n`;
            });
        } else {
            message += `• None loaded\n`;
        }
        
        message += `\n🎨 *Custom (${customModules.length}):*\n`;
        if (customModules.length > 0) {
            customModules.forEach(mod => {
                const cmdCount = mod.commands ? mod.commands.length : 0;
                message += `• ${mod.name} (${cmdCount})\n`;
            });
        } else {
            message += `• None loaded\n`;
        }
        
        message += `\n📊 Total: ${systemModules.length + customModules.length} modules`;
        return message;
    }
}

module.exports = MessageFormatter;