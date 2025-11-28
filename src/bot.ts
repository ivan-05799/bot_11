import { Telegraf } from 'telegraf';
import { Client } from 'pg';
import dotenv from 'dotenv';
import express from 'express';

dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DB_URL = process.env.DATABASE_URL;
const WEBHOOK_PORT = process.env.PORT || 3000;

if (!BOT_TOKEN || !DB_URL) {
  throw new Error('Не заданы переменные окружения!');
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());

// Функция для создания нового подключения к БД
async function getDbConnection() {
  const db = new Client({ 
    connectionString: DB_URL,
    // Настройки для Neon
    connectionTimeoutMillis: 5000,
    idle_in_transaction_session_timeout: 10000
  });
  await db.connect();
  return db;
}

function isLikelyApiKey(text: string): boolean {
  return text.length > 20 && /[a-zA-Z0-9._-]{20,}/.test(text);
}

// Webhook endpoint
app.post('/api/send-message', async (req, res) => {
  try {
    const { chat_id, message } = req.body;
    
    if (!chat_id || !message) {
      return res.status(400).json({ error: 'Не указаны chat_id или message' });
    }

    console.log(`📨 Запрос на отправку пользователю ${chat_id}`);
    await bot.telegram.sendMessage(chat_id, message, { parse_mode: 'Markdown' });
    
    console.log(`✅ Сообщение отправлено`);
    res.json({ success: true });
    
  } catch (error) {
    console.error('❌ Ошибка отправки:', error);
    res.status(500).json({ error: 'Ошибка отправки сообщения' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'telegram-bot' });
});

async function startBot() {
  console.log('🤖 Запуск бота...');

  // Команда /start
  bot.start(async (ctx) => {
    let db;
    try {
      db = await getDbConnection();
      
      await ctx.reply(
        '🔑 *Добро пожаловать в Skayfol Analytics!*\n\n' +
        'Для подключения аналитики отправьте ваш API-ключ от рекламного кабинета.\n\n' +
        '*Просто введите ключ в чат* 🔽',
        { parse_mode: 'Markdown' }
      );
    } catch (error) {
      console.error('❌ Ошибка БД:', error);
      await ctx.reply('⚠️ Временная ошибка сервиса. Попробуйте позже.');
    } finally {
      if (db) await db.end();
    }
  });

  // Обработка сообщений
  bot.on('text', async (ctx) => {
    const message = ctx.message.text;
    const chatId = ctx.chat.id;

    if (isLikelyApiKey(message)) {
      let db;
      try {
        db = await getDbConnection();
        
        await db.query(
          `INSERT INTO api_keys (chat_id, api_key, platform) 
           VALUES ($1, $2, $3)`,
          [chatId, message, 'unknown']
        );
        
        await ctx.reply(
          '✅ *API-ключ принят!*\n\n' +
          'Мы начали обработку ваших данных. Это займет несколько минут.\n' +
          'Вы получите уведомление когда аналитика будет готова.',
          { parse_mode: 'Markdown' }
        );

        console.log(`🔑 Новый API-ключ от пользователя ${chatId}`);

      } catch (error) {
        console.error('❌ Ошибка сохранения:', error);
        await ctx.reply('⚠️ Ошибка при сохранении ключа. Попробуйте еще раз.');
      } finally {
        if (db) await db.end();
      }
    } else if (!message.startsWith('/')) {
      await ctx.reply(
        '🔑 *Отправьте ваш API-ключ*\n\n' +
        'Просто скопируйте и вставьте ключ из рекламного кабинета.',
        { parse_mode: 'Markdown' }
      );
    }
  });

  bot.help(async (ctx) => {
    await ctx.reply(
      '🤖 *Помощь по боту*\n\n' +
      'Чтобы подключить аналитику:\n' +
      '1. Скопируйте API-ключ из рекламного кабинета\n' +
      '2. Вставьте ключ в этот чат\n' +
      '3. Мы обработаем данные и пришлем результаты',
      { parse_mode: 'Markdown' }
    );
  });

  // Запуск
  bot.launch();
  console.log('🤖 Бот запущен и ждет API-ключи...');

  app.listen(WEBHOOK_PORT, () => {
    console.log(`🌐 Webhook сервер на порту ${WEBHOOK_PORT}`);
  });
}

// Обработка ошибок
process.on('unhandledRejection', (reason, promise) => {
  console.log('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.log('❌ Uncaught Exception:', error);
});

startBot().catch(console.error);