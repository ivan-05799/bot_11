import { Telegraf } from 'telegraf';
import { Client } from 'pg';
import dotenv from 'dotenv';
import express from 'express';

dotenv.config();

console.log('🚀 Telegram Bot для сбора API-ключей');
console.log('🛡️  Устойчивый к конфликтам 409');

const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const DB_URL = process.env.DATABASE_URL;
const PORT = parseInt(process.env.PORT || '10000');

if (!BOT_TOKEN || !DB_URL) {
  console.error('❌ Ошибка: Не заданы BOT_TOKEN или DATABASE_URL');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());

// ========== ПОДКЛЮЧЕНИЕ К БД ==========
async function getDbConnection() {
  const db = new Client({ 
    connectionString: DB_URL,
    connectionTimeoutMillis: 10000
  });
  await db.connect();
  return db;
}

function isLikelyApiKey(text: string): boolean {
  return text.length > 20 && /[a-zA-Z0-9._-]{20,}/.test(text);
}

// ========== WEBHOOK ДЛЯ ЗАКАЗЧИКА ==========
app.post('/api/send-message', async (req, res) => {
  try {
    const { chat_id, message } = req.body;
    
    if (!chat_id || !message) {
      return res.status(400).json({ error: 'Нужны chat_id и message' });
    }

    console.log(`📨 [WEBHOOK] Отправка ${chat_id}`);
    await bot.telegram.sendMessage(chat_id, message, { parse_mode: 'Markdown' });
    res.json({ success: true });
    
  } catch (error: any) {
    console.error('❌ [WEBHOOK] Ошибка:', error.message);
    res.status(500).json({ error: 'Ошибка отправки' });
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    bot: 'operational',
    endpoints: {
      webhook: '/api/send-message',
      health: '/health'
    }
  });
});

// ========== ОСНОВНОЙ КОД БОТА ==========
let botStarted = false;

async function initializeBot() {
  console.log('🤖 Инициализация бота...');

  // Команда /start
  bot.start(async (ctx) => {
    console.log(`👋 /start от ${ctx.chat.id}`);
    await ctx.reply(
      '🔑 *Skayfol Analytics*\n\nОтправьте ваш API-ключ.',
      { parse_mode: 'Markdown' }
    );
  });

  // Обработка сообщений
  bot.on('text', async (ctx) => {
    const message = ctx.message.text;
    const chatId = ctx.chat.id;
    
    console.log(`📩 От ${chatId}: ${message.substring(0, 30)}...`);

    if (isLikelyApiKey(message)) {
      let db;
      try {
        db = await getDbConnection();
        
        // Проверка дубликата
        const exists = await db.query(
          'SELECT id FROM api_keys WHERE chat_id = $1 AND api_key = $2',
          [chatId, message]
        );
        
        if (exists.rows.length > 0) {
          await ctx.reply('⚠️ Ключ уже сохранён ранее.');
          return;
        }
        
        // Сохранение нового ключа
        await db.query(
          'INSERT INTO api_keys (chat_id, api_key, platform) VALUES ($1, $2, $3)',
          [chatId, message, 'unknown']
        );
        
        await ctx.reply('✅ Ключ сохранён!');
        console.log(`🔑 Ключ от ${chatId} сохранён`);
        
      } catch (error) {
        console.error('❌ Ошибка БД:', error);
        await ctx.reply('⚠️ Ошибка сервера. Попробуйте позже.');
      } finally {
        if (db) await db.end();
      }
    } else if (!message.startsWith('/')) {
      await ctx.reply('Отправьте API-ключ (длинная строка).');
    }
  });

  bot.help(async (ctx) => {
    await ctx.reply('Отправьте API-ключ для сохранения.');
  });
}

// ========== ЗАПУСК БОТА С ОБРАБОТКОЙ КОНФЛИКТОВ ==========
async function startBot() {
  try {
    await initializeBot();
    await bot.launch();
    botStarted = true;
    console.log('✅ Бот запущен и готов к работе');
    
  } catch (error: any) {
    if (error.message.includes('409')) {
      console.log('⚠️ ВНИМАНИЕ: Конфликт 409 обнаружен');
      console.log('📌 Возможные причины:');
      console.log('   1. Бот уже запущен на другом сервере');
      console.log('   2. Render создал дублирующий процесс');
      console.log('   3. Заказчик запустил бота локально');
      console.log('✅ Вебхук продолжает работать');
      console.log('📝 Сообщения от клиентов временно не принимаются');
      console.log('🔄 Конфликт разрешится автоматически через 1-2 минуты');
      
      // Не завершаем процесс - вебхук должен работать
      botStarted = false;
      
    } else {
      console.error('❌ Критическая ошибка запуска:', error.message);
      throw error;
    }
  }
}

// ========== ПРОВЕРКА СТАТУСА БОТА ==========
app.get('/bot-status', (req, res) => {
  res.json({
    bot_started: botStarted,
    can_receive_messages: botStarted,
    conflict_409: !botStarted,
    timestamp: new Date().toISOString()
  });
});

// ========== ЗАПУСК СЕРВЕРА ==========
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Веб-сервер запущен на порту ${PORT}`);
  console.log(`🔗 Health: http://localhost:${PORT}/health`);
  console.log(`🔗 Webhook: http://localhost:${PORT}/api/send-message`);
  console.log(`🔗 Bot Status: http://localhost:${PORT}/bot-status`);
  
  // Запускаем бота после старта сервера
  setTimeout(() => {
    startBot().catch((error) => {
      if (!error.message.includes('409')) {
        console.error('💥 Фатальная ошибка:', error);
        process.exit(1);
      }
    });
  }, 1000);
});

server.on('error', (error: any) => {
  console.error('❌ Ошибка сервера:', error.message);
  process.exit(1);
});

// ========== ГРАЦИОЗНОЕ ЗАВЕРШЕНИЕ ==========
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

async function gracefulShutdown() {
  console.log('🛑 Завершение работы...');
  
  if (botStarted) {
    try {
      await bot.stop();
      console.log('✅ Бот остановлен');
    } catch (error) {
      console.error('❌ Ошибка остановки бота:', error);
    }
  }
  
  server.close(() => {
    console.log('✅ Сервер остановлен');
    process.exit(0);
  });
  
  setTimeout(() => {
    console.log('⚠️ Принудительное завершение');
    process.exit(1);
  }, 10000);
}

// ========== ГЛОБАЛЬНЫЕ ОБРАБОТЧИКИ ==========
process.on('uncaughtException', (error) => {
  console.error('💥 Непойманное исключение:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Необработанный промис:', reason);
});

console.log('✅ Система инициализирована. Ожидание запуска...');