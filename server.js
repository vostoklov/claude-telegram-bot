const { Telegraf } = require('telegraf');
const axios = require('axios');

// Load environment variables from .env (optional)
require('dotenv').config();

const botToken = process.env.TELEGRAM_BOT_TOKEN;
const anthropicApiKey = process.env.ANTHROPIC_API_KEY;

if (!botToken || !anthropicApiKey) {
  console.error('Error: TELEGRAM_BOT_TOKEN and ANTHROPIC_API_KEY must be set in environment variables.');
  process.exit(1);
}

const bot = new Telegraf(botToken);

bot.on('text', async (ctx) => {
  const userMessage = ctx.message.text;
  try {
    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-3-sonnet-20240229', // you can change model
      max_tokens: 256,
      messages: [
        { role: 'user', content: userMessage }
      ]
    }, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicApiKey,
        'anthropic-version': '2023-06-01'
      }
    });

    const assistantReply = response.data?.content?.[0]?.text || 'No response';
    await ctx.reply(assistantReply);
  } catch (error) {
    console.error('Error contacting Claude API:', error);
    ctx.reply('Sorry, there was an error processing your request.');
  }
});

bot.launch().then(() => {
  console.log('Claude Telegram bot is running.');
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
