import { Telegraf, Markup } from 'telegraf';
import { Client } from 'pg';
import dotenv from 'dotenv';
import express from 'express';

dotenv.config();

// ========== КОНФИГУРАЦИЯ ==========
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const DB_URL = process.env.DATABASE_URL;
const PORT = parseInt(process.env.PORT || '10000');

if (!BOT_TOKEN || !DB_URL) {
  console.error('❌ Нет BOT_TOKEN или DATABASE_URL');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());

// ========== КЛАВИАТУРЫ ==========
const mainMenu = Markup.keyboard([
  ['🔑 Отправить API-ключ'],
  ['📊 Мой статус', '🆘 Помощь'],
  ['📞 Связаться с поддержкой']
]).resize();

const removeKeyboard = Markup.removeKeyboard();

// ========== ПОДКЛЮЧЕНИЕ К БД ==========
async function getDbConnection() {
  const db = new Client({ 
    connectionString: DB_URL,
    connectionTimeoutMillis: 10000
  });
  await db.connect();
  return db;
}

// ========== WEBHOOK ДЛЯ БЭКЕНДА ==========
app.post('/api/send-message', async (req, res) => {
  try {
    const { chat_id, message } = req.body;
    
    if (!chat_id || !message) {
      return res.status(400).json({ error: 'Нужны chat_id и message' });
    }

    await bot.telegram.sendMessage(chat_id, message, { 
      parse_mode: 'Markdown',
      ...mainMenu 
    });
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
    version: '2.0',
    features: ['keyboard', 'status-check', 'auto-recovery']
  });
});

// ========== КОМАНДА /start С КНОПКАМИ ==========
bot.start(async (ctx) => {
  console.log(`🚀 /start от ${ctx.chat.id} (${ctx.from.first_name})`);
  
  await ctx.reply(
    `*🔐 Skayfol Analytics*\n\n` +
    `Добро пожаловать в систему аналитики рекламных кампаний!\n\n` +
    `*Что умеет бот:*\n` +
    `✅ Принимает API-ключи\n` +
    `✅ Сохраняет в безопасное хранилище\n` +
    `✅ Уведомляет о результатах анализа\n\n` +
    `Выберите действие:`,
    { 
      parse_mode: 'Markdown',
      ...mainMenu 
    }
  );
});

// ========== КНОПКА: ОТПРАВИТЬ API-КЛЮЧ ==========
bot.hears('🔑 Отправить API-ключ', async (ctx) => {
  await ctx.reply(
    'Отправьте ваш API-ключ *одной строкой*.\n\n' +
    '_Ключ должен быть длинным (от 30 символов)_',
    { 
      parse_mode: 'Markdown',
      ...removeKeyboard 
    }
  );
});

// ========== КНОПКА: МОЙ СТАТУС ==========
bot.hears('📊 Мой статус', async (ctx) => {
  let db;
  try {
    db = await getDbConnection();
    const result = await db.query(
      `SELECT COUNT(*) as total, 
              MAX(created_at) as last_added
       FROM api_keys 
       WHERE chat_id = $1`,
      [ctx.chat.id]
    );
    
    const total = result.rows[0].total || 0;
    const lastAdded = result.rows[0].last_added 
      ? new Date(result.rows[0].last_added).toLocaleString('ru-RU')
      : 'ещё нет';
    
    await ctx.reply(
      `*📊 Ваша статистика*\n\n` +
      `🔑 Ключей сохранено: *${total}*\n` +
      `⏰ Последний добавлен: *${lastAdded}*\n\n` +
      `_Статус обработки: активен_`,
      { 
        parse_mode: 'Markdown',
        ...mainMenu 
      }
    );
    
  } catch (error) {
    console.error('❌ Ошибка получения статуса:', error);
    await ctx.reply('⚠️ Не удалось получить статистику', mainMenu);
  } finally {
    if (db) await db.end();
  }
});

// ========== КНОПКА: ПОМОЩЬ ==========
bot.hears('🆘 Помощь', async (ctx) => {
  await ctx.reply(
    `*❓ Частые вопросы:*\n\n` +
    `🔹 *Где взять API-ключ?*\n` +
    `В настройках вашего рекламного кабинета\n\n` +
    `🔹 *Ключ не принимается?*\n` +
    `Убедитесь что скопировали полностью (30+ символов)\n\n` +
    `🔹 *Как долго обрабатывается?*\n` +
    `Обычно 5-15 минут\n\n` +
    `🔹 *Данные в безопасности?*\n` +
    `Да, ключи хранятся в зашифрованной базе`,
    { 
      parse_mode: 'Markdown',
      ...mainMenu 
    }
  );
});

// ========== КНОПКА: СВЯЗАТЬСЯ ==========
bot.hears('📞 Связаться с поддержкой', async (ctx) => {
  await ctx.reply(
    `*📞 Контакты поддержки*\n\n` +
    `📧 Email: support@skayfol.com\n` +
    `🌐 Сайт: https://skayfol.com\n` +
    `⏰ Часы работы: 9:00-18:00 (МСК)\n\n` +
    `_Ответим в течение 24 часов_`,
    { 
      parse_mode: 'Markdown',
      ...mainMenu 
    }
  );
});

// ========== ОБРАБОТКА API-КЛЮЧЕЙ ==========
bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  const chatId = ctx.chat.id;
  
  // Пропускаем команды и кнопки
  if (text.startsWith('/') || 
      ['🔑 Отправить API-ключ', '📊 Мой статус', '🆘 Помощь', '📞 Связаться с поддержкой'].includes(text)) {
    return;
  }
  
  // Проверяем похоже ли на API-ключ
  if (text.length > 25 && /[a-zA-Z0-9._-]{25,}/.test(text)) {
    console.log(`🔑 Попытка сохранения ключа от ${chatId}`);
    
    let db;
    try {
      db = await getDbConnection();
      
      // Проверка дубликата
      const exists = await db.query(
        'SELECT id, created_at FROM api_keys WHERE chat_id = $1 AND api_key = $2',
        [chatId, text]
      );
      
      if (exists.rows.length > 0) {
        const savedAt = new Date(exists.rows[0].created_at).toLocaleString('ru-RU');
        await ctx.reply(
          `⚠️ *Этот ключ уже был сохранён!*\n\n` +
          `_Дата сохранения: ${savedAt}_\n\n` +
          `Если нужно обновить ключ - свяжитесь с поддержкой.`,
          { 
            parse_mode: 'Markdown',
            ...mainMenu 
          }
        );
        return;
      }
      
      // Сохранение нового ключа
      await db.query(
        'INSERT INTO api_keys (chat_id, api_key, platform) VALUES ($1, $2, $3)',
        [chatId, text, 'unknown']
      );
      
      await ctx.reply(
        `✅ *Ключ успешно сохранён!*\n\n` +
        `Мы начали обработку ваших данных.\n` +
        `Вы получите уведомление когда анализ будет готов.\n\n` +
        `_Обычно это занимает 5-15 минут_`,
        { 
          parse_mode: 'Markdown',
          ...mainMenu 
        }
      );
      
      console.log(`✅ Ключ от ${chatId} сохранён`);
      
    } catch (error) {
      console.error('❌ Ошибка БД:', error);
      await ctx.reply(
        '⚠️ *Ошибка сервера*\n\nПожалуйста, попробуйте позже.',
        { 
          parse_mode: 'Markdown',
          ...mainMenu 
        }
      );
    } finally {
      if (db) await db.end();
    }
  } else {
    // Не похоже на ключ - показываем меню
    await ctx.reply(
      'Пожалуйста, используйте кнопки меню или отправьте API-ключ.',
      mainMenu
    );
  }
});

// ========== ЗАПУСК СИСТЕМЫ ==========
let botStarted = false;

async function startBot() {
  try {
    // Очищаем старые webhook
    await bot.telegram.deleteWebhook();
    console.log('✅ Очищены старые webhook');
    
    await bot.launch();
    botStarted = true;
    console.log('✅ Бот запущен с кнопочным меню');
    
  } catch (error: any) {
    if (error.message.includes('409')) {
      console.log('⚠️ Конфликт 409 - временно, вебхук работает');
      botStarted = false;
    } else {
      console.error('❌ Ошибка запуска:', error);
      throw error;
    }
  }
}

// ========== ЗАПУСК СЕРВЕРА ==========
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Сервер на порту ${PORT}`);
  console.log(`🤖 Версия: 2.0 (кнопочное меню)`);
  
  setTimeout(startBot, 1000);
});

server.on('error', (error: any) => {
  console.error('❌ Ошибка сервера:', error.message);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Завершение работы...');
  process.exit(0);
});

console.log('🚀 Система инициализирована');