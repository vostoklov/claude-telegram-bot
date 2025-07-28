// server.js
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();

// Конфигурация из переменных окружения
const BOT_TOKEN = process.env.BOT_TOKEN;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const YOUR_TELEGRAM_ID = process.env.YOUR_TELEGRAM_ID;

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const app = express();

// База данных для истории
const db = new sqlite3.Database('bot_history.db');
db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT,
    message_text TEXT,
    message_type TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_command BOOLEAN DEFAULT 0
)`);

// Функция вызова Claude API
async function callClaude(prompt, conversationHistory = []) {
    try {
        // Определяем системный промпт для Claude — передаётся отдельно, не в messages
        const systemPrompt = `Ты помощник Ивана через Telegram бота. Отвечай кратко, дружелюбно и по делу, в стиле обычного общения. 
        Если Иван пересылает диалоги или сообщения, помоги их обработать или проанализировать по его просьбе.
        Текущее время: ${new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Yerevan' })}.`;

        // Формируем messages без системной роли: берём историю переписки и текущее сообщение
        const messages = [
            ...conversationHistory,
            {
                role: "user", 
                content: prompt
            }
        ];

        const response = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": CLAUDE_API_KEY,
                "anthropic-version": "2023-06-01"
            },
            body: JSON.stringify({
                model: "claude-sonnet-4-20250514",
                max_tokens: 1500,
                system: systemPrompt,
                messages: messages
            })
        });

        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(`Claude API error: ${data.error?.message || 'Unknown error'}`);
        }

        return data.content?.[0]?.text || data.content || '';
    } catch (error) {
        console.error('Claude API Error:', error);
        return `❌ Ошибка связи с Claude: ${error.message}`;
    }
}

// Функция получения истории сообщений
function getMessageHistory(minutes = 30, limit = 50) {
    return new Promise((resolve, reject) => {
        const timeAgo = new Date(Date.now() - minutes * 60 * 1000).toISOString();
        
        db.all(
            `SELECT * FROM messages 
             WHERE timestamp > ? 
             ORDER BY timestamp ASC 
             LIMIT ?`,
            [timeAgo, limit],
            (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            }
        );
    });
}

// Буфер для пересланных сообщений
let forwardedMessagesBuffer = [];
let forwardedMessagesTimer = null;
const BATCH_TIMEOUT = 60000; // 1 минута в миллисекундах

// Функция обработки накопленных пересланных сообщений
async function processForwardedBatch(chatId) {
    if (forwardedMessagesBuffer.length === 0) return;
    
    try {
        // Объединяем все пересланные сообщения
        const combinedText = forwardedMessagesBuffer
            .map(msg => {
                const sender = msg.forward_from?.first_name || 
                             msg.forward_from?.username || 
                             msg.forward_from_chat?.title || 
                             'Unknown';
                return `${sender}: ${msg.text || msg.caption || '[Media]'}`;
            })
            .join('\n');

        // Отправляем на анализ
        bot.sendMessage(chatId, '🔍 Анализирую пересланные сообщения...');
        
        const prompt = `Проанализируй эти пересланные из чата сообщения и объедини их в связный контекст:

${combinedText}

Дай краткий анализ: основные темы, настроение участников, ключевые моменты диалога.`;

        const analysis = await callClaude(prompt);
        
        bot.sendMessage(chatId, `📊 *Анализ пересланных сообщений:*\n\n${analysis}`, {
            parse_mode: 'Markdown'
        });
        
        // Очищаем буфер
        forwardedMessagesBuffer = [];
        
    } catch (error) {
        console.error('Error processing forwarded batch:', error);
        bot.sendMessage(chatId, '❌ Ошибка анализа пересланных сообщений');
        forwardedMessagesBuffer = [];
    }
}
function saveMessage(userId, username, text, type = 'text', isCommand = false) {
    db.run(
        'INSERT INTO messages (user_id, username, message_text, message_type, is_command) VALUES (?, ?, ?, ?, ?)',
        [userId, username, text, type, isCommand ? 1 : 0]
    );
}

// Команды бота
const commands = {
    '/start': async (msg) => {
        const welcome = `
🤖 *Claude Bot активен!*

Доступные команды:
• \`/history [минуты]\` - История переписки (по умолчанию 30 мин)
• \`/analyze\` - Анализ последних сообщений
• \`/summary [минуты]\` - Краткое резюме переписки
• \`/clear\` - Очистить историю
• \`/process\` - Обработать накопленные пересланные сообщения досрочно
• \`/stats\` - Статистика бота

Или просто напиши что-нибудь, и я отвечу через Claude! 💬
        `;
        
        bot.sendMessage(msg.chat.id, welcome, { parse_mode: 'Markdown' });
    },

    '/history': async (msg) => {
        const args = msg.text.split(' ');
        const minutes = parseInt(args[1]) || 30;
        
        try {
            const history = await getMessageHistory(minutes);
            
            if (history.length === 0) {
                bot.sendMessage(msg.chat.id, `📭 Нет сообщений за последние ${minutes} минут`);
                return;
            }

            const formatted = history.map(h => 
                `[${new Date(h.timestamp).toLocaleTimeString('ru-RU')}] ${h.username || 'Unknown'}: ${h.message_text}`
            ).join('\n');

            // Если слишком длинно, отправляем файлом
            if (formatted.length > 3000) {
                bot.sendDocument(msg.chat.id, Buffer.from(formatted), {
                    filename: `history_${minutes}min.txt`,
                    caption: `📄 История за ${minutes} минут (${history.length} сообщений)`
                });
            } else {
                bot.sendMessage(msg.chat.id, `📋 *История за ${minutes} минут:*\n\n\`\`\`\n${formatted}\n\`\`\``, {
                    parse_mode: 'Markdown'
                });
            }
        } catch (error) {
            bot.sendMessage(msg.chat.id, '❌ Ошибка получения истории');
        }
    },

    '/analyze': async (msg) => {
        try {
            // Проверяем, есть ли текст после команды
            const commandText = msg.text.replace('/analyze', '').trim();
            
            let historyText = '';
            
            if (commandText) {
                // Если есть текст после команды, анализируем его
                historyText = commandText;
                bot.sendMessage(msg.chat.id, '🔍 Анализирую переданный диалог...');
            } else {
                // Если текста нет, берём историю сообщений
                const history = await getMessageHistory(60); // Последний час
                
                if (history.length === 0) {
                    bot.sendMessage(msg.chat.id, '📭 Нет данных для анализа');
                    return;
                }

                historyText = history.map(h => 
                    `${h.username}: ${h.message_text}`
                ).join('\n');
                
                bot.sendMessage(msg.chat.id, '🔍 Анализирую переписку...');
            }

            const prompt = `Проанализируй эту переписку и дай краткие инсайты:
            
${historyText}

Что интересного в диалоге? Какие темы, настроение, паттерны?`;

            const analysis = await callClaude(prompt);
            
            bot.sendMessage(msg.chat.id, `📊 *Анализ переписки:*\n\n${analysis}`, {
                parse_mode: 'Markdown'
            });
        } catch (error) {
            bot.sendMessage(msg.chat.id, '❌ Ошибка анализа');
        }
    },

    '/process': async (msg) => {
        // Мануальная команда для обработки накопленных пересланных сообщений
        if (forwardedMessagesBuffer.length > 0) {
            if (forwardedMessagesTimer) {
                clearTimeout(forwardedMessagesTimer);
                forwardedMessagesTimer = null;
            }
            await processForwardedBatch(msg.chat.id);
            bot.sendMessage(msg.chat.id, '✅ Обработал накопленные сообщения досрочно');
        } else {
            bot.sendMessage(msg.chat.id, '📭 Нет пересланных сообщений для обработки');
        }
    },

    '/summary': async (msg) => {
        const args = msg.text.split(' ');
        const minutes = parseInt(args[1]) || 30;
        
        try {
            const history = await getMessageHistory(minutes);
            
            if (history.length === 0) {
                bot.sendMessage(msg.chat.id, `📭 Нет сообщений за последние ${minutes} минут`);
                return;
            }

            const historyText = history.map(h => 
                `${h.username}: ${h.message_text}`
            ).join('\n');

            const prompt = `Сделай краткое резюме этой переписки за последние ${minutes} минут. 
            Выдели ключевые моменты, решения, задачи:

${historyText}`;

            bot.sendMessage(msg.chat.id, '📝 Создаю резюме...');
            const summary = await callClaude(prompt);
            
            bot.sendMessage(msg.chat.id, `📝 *Резюме за ${minutes} минут:*\n\n${summary}`, {
                parse_mode: 'Markdown'
            });
        } catch (error) {
            bot.sendMessage(msg.chat.id, '❌ Ошибка создания резюме');
        }
    },

    '/clear': async (msg) => {
        db.run('DELETE FROM messages', (err) => {
            if (err) {
                bot.sendMessage(msg.chat.id, '❌ Ошибка очистки');
            } else {
                bot.sendMessage(msg.chat.id, '🗑️ История очищена');
            }
        });
    },

    '/stats': async (msg) => {
        db.all(`
            SELECT 
                COUNT(*) as total,
                COUNT(CASE WHEN is_command = 1 THEN 1 END) as commands,
                COUNT(CASE WHEN timestamp > datetime('now', '-1 hour') THEN 1 END) as last_hour,
                COUNT(CASE WHEN timestamp > datetime('now', '-1 day') THEN 1 END) as last_day
            FROM messages
        `, (err, rows) => {
            if (err) {
                bot.sendMessage(msg.chat.id, '❌ Ошибка статистики');
                return;
            }

            const stats = rows[0];
            const statsText = `📈 *Статистика бота:*

📊 Всего сообщений: ${stats.total}
⚡ Команд выполнено: ${stats.commands}
🕐 За последний час: ${stats.last_hour}
📅 За последний день: ${stats.last_day}

🤖 Бот работает с ${new Date().toLocaleString('ru-RU')}`;

            bot.sendMessage(msg.chat.id, statsText, { parse_mode: 'Markdown' });
        });
    }
};

// Обработка сообщений
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = msg.from.username || msg.from.first_name || 'Unknown';
    const text = msg.text || msg.caption || '';

    // Проверка доступа (только ты можешь использовать)
    if (YOUR_TELEGRAM_ID && userId.toString() !== YOUR_TELEGRAM_ID) {
        bot.sendMessage(chatId, '🚫 Доступ запрещён');
        return;
    }

    // Обработка пересланных сообщений
    if (msg.forward_from || msg.forward_from_chat) {
        console.log('Received forwarded message, adding to buffer');
        
        // Добавляем в буфер
        forwardedMessagesBuffer.push(msg);
        
        // Если это первое сообщение в буфере, запускаем таймер
        if (forwardedMessagesBuffer.length === 1) {
            bot.sendMessage(chatId, '📝 Получены пересланные сообщения, жду остальные (60 сек)...');
            
            forwardedMessagesTimer = setTimeout(() => {
                console.log('Processing forwarded messages batch');
                processForwardedBatch(chatId);
                forwardedMessagesTimer = null;
            }, BATCH_TIMEOUT);
        }
        
        return; // Не обрабатываем пересланные сообщения дальше
    }

    // Сохраняем обычное сообщение
    const isCommand = text.startsWith('/');
    saveMessage(userId, username, text, 'text', isCommand);

    // Обработка команд
    if (isCommand) {
        const command = text.split(' ')[0];
        if (commands[command]) {
            await commands[command](msg);
            return;
        }
    }

    // Если не команда, отправляем в Claude
    if (!isCommand && text.trim()) {
        try {
            // Упрощённый контекст - только текущее сообщение
            console.log(`User message: ${text}`);
            
            bot.sendChatAction(chatId, 'typing');
            const response = await callClaude(text);
            
            console.log(`Claude response: ${response}`);
            bot.sendMessage(chatId, response);
            
            // Сохраняем ответ Claude
            saveMessage(0, 'Claude', response, 'response', false);
            
        } catch (error) {
            console.error('Error processing message:', error);
            bot.sendMessage(chatId, '❌ Что-то пошло не так. Попробуй ещё раз.');
        }
    }
});

// Обработка ошибок
bot.on('error', (error) => {
    console.error('Bot error:', error);
});

// Запуск веб-сервера для health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🤖 Bot server running on port ${PORT}`);
    console.log(`📱 Send /start to your bot to begin`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('🛑 Shutting down bot...');
    bot.stopPolling();
    db.close();
    process.exit();
});
