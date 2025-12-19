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
  ['🔑 Отправить API-ключ', '📊 Мой статус'],
  ['📞 Связаться с поддержкой', '🏠 Главное меню']
]).resize();

const platformMenu = Markup.keyboard([
  ['1. Meta', '2. Tik Tok'],
  ['3. Google', '4. Others'],
  ['↩️ Назад', '🏠 Главное меню']
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

// ========== WEBHOOK ДЛЯ ЗАКАЗЧИКА ==========
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
    version: '2.4',
    features: ['platform-selection', 'status-check', 'support-button', 'main-menu']
  });
});

// ========== ХРАНЕНИЕ ВРЕМЕННЫХ ДАННЫХ ==========
const userStates = new Map();

// ========== КОМАНДА /start И КНОПКА ГЛАВНОГО МЕНЮ ==========
async function showMainMenu(ctx) {
  await ctx.reply(
    `*🔐 Skayfol Analytics*\n\n` +
    `Добро пожаловать в систему аналитики рекламных кампаний!\n\n` +
    `*Что умеет бот:*\n` +
    `✅ Принимает API-ключи от разных платформ\n` +
    `✅ Сохраняет в безопасное хранилище\n` +
    `✅ Уведомляет о результатах анализа\n\n` +
    `*Для связи с поддержкой:*\n` +
    `Используйте кнопку "📞 Связаться с поддержкой"`,
    { 
      parse_mode: 'Markdown',
      ...mainMenu 
    }
  );
}

bot.start(async (ctx) => {
  console.log(`🚀 /start от ${ctx.chat.id} (${ctx.from.first_name})`);
  await showMainMenu(ctx);
});

bot.hears('🏠 Главное меню', async (ctx) => {
  console.log(`🔄 Главное меню от ${ctx.chat.id}`);
  await showMainMenu(ctx);
});

// ========== КНОПКА: СВЯЗАТЬСЯ С ПОДДЕРЖКОЙ ==========
bot.hears('📞 Связаться с поддержкой', async (ctx) => {
  await ctx.reply(
    `*📞 Поддержка Skayfol Analytics*\n\n` +
    `По всем вопросам обращайтесь:\n` +
    `👉 @Seo_skayfol_analytics\n\n` +
    `*Часы работы:*\n` +
    `Пн-Пт: 10:00-20:00\n` +
    `Сб-Вс: 12:00-18:00\n\n` +
    `_Среднее время ответа: 15-30 минут_`,
    { 
      parse_mode: 'Markdown',
      ...mainMenu 
    }
  );
});

// ========== КНОПКА: ОТПРАВИТЬ API-КЛЮЧ ==========
bot.hears('🔑 Отправить API-ключ', async (ctx) => {
  await ctx.reply(
    'Выберите платформу для которой добавляете API-ключ:',
    { 
      parse_mode: 'Markdown',
      ...platformMenu 
    }
  );
});

// ========== КНОПКА: МОЙ СТАТУС ==========
bot.hears('📊 Мой статус', async (ctx) => {
  let db;
  try {
    db = await getDbConnection();
    const result = await db.query(
      `SELECT platform, COUNT(*) as count
       FROM api_keys 
       WHERE chat_id = $1
       GROUP BY platform
       ORDER BY platform`,
      [ctx.chat.id]
    );
    
    let message = '*📊 Ваша статистика*\n\n';
    
    if (result.rows.length === 0) {
      message += 'У вас пока нет сохранённых ключей.\nИспользуйте кнопку "🔑 Отправить API-ключ" чтобы добавить первый ключ.';
    } else {
      const platformNames = {
        'meta': 'Meta',
        'tiktok': 'Tik Tok', 
        'google': 'Google',
        'others': 'Другие'
      };
      
      result.rows.forEach(row => {
        const platformName = platformNames[row.platform] || row.platform;
        message += `• ${platformName}: ${row.count} ключей\n`;
      });
      
      const total = result.rows.reduce((sum, row) => sum + parseInt(row.count), 0);
      message += `\n*Всего: ${total} ключей*`;
    }
    
    await ctx.reply(
      message,
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

// ========== ВЫБОР ПЛАТФОРМЫ ==========
bot.hears(['1. Meta', '2. Tik Tok', '3. Google', '4. Others'], async (ctx) => {
  const platformMap = {
    '1. Meta': 'meta',
    '2. Tik Tok': 'tiktok', 
    '3. Google': 'google',
    '4. Others': 'others'
  };
  
  const platform = platformMap[ctx.message.text];
  const platformNames = {
    'meta': 'Meta',
    'tiktok': 'Tik Tok',
    'google': 'Google',
    'others': 'Другие платформы'
  };
  
  // Сохраняем выбранную платформу для пользователя
  userStates.set(ctx.chat.id, { 
    platform, 
    platformDisplay: platformNames[platform],
    waitingForKey: true 
  });
  
  await ctx.reply(
    `Выбрана платформа: *${platformNames[platform]}*\n\n` +
    `Теперь отправьте ваш API-ключ *одной строкой*.\n\n` +
    `*Пример формата:*\n` +
    `\`sk_test_51Nm...\` (тестовый ключ)\n` +
    `\`eyJ0eXAiOiJKV1QiLCJhbGciOiJ...\` (JWT токен)\n\n` +
    `_Ключ должен быть длинным (от 30 символов)_`,
    { 
      parse_mode: 'Markdown',
      ...removeKeyboard 
    }
  );
});

// ========== КНОПКА НАЗАД ==========
bot.hears('↩️ Назад', async (ctx) => {
  userStates.delete(ctx.chat.id);
  await ctx.reply(
    'Выберите действие:',
    { 
      parse_mode: 'Markdown',
      ...mainMenu 
    }
  );
});

// ========== ОБРАБОТКА API-КЛЮЧЕЙ С ПЛАТФОРМОЙ ==========
bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  const chatId = ctx.chat.id;
  
  // Пропускаем команды и кнопки
  const menuItems = [
    '🔑 Отправить API-ключ', '📊 Мой статус', '🏠 Главное меню',
    '📞 Связаться с поддержкой',
    '1. Meta', '2. Tik Tok', '3. Google', '4. Others', '↩️ Назад'
  ];
  
  if (text.startsWith('/') || menuItems.includes(text)) {
    return;
  }
  
  const userState = userStates.get(chatId);
  
  // Проверяем похоже ли на API-ключ и есть ли выбранная платформа
  if (text.length > 25 && /[a-zA-Z0-9._-]{25,}/.test(text) && userState?.waitingForKey) {
    console.log(`🔑 Попытка сохранения ключа от ${chatId} для платформы ${userState.platform}`);
    
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
          `Выберите действие:`,
          { 
            parse_mode: 'Markdown',
            ...mainMenu 
          }
        );
        userStates.delete(chatId);
        return;
      }
      
      // Сохранение нового ключа с платформой
      await db.query(
        'INSERT INTO api_keys (chat_id, api_key, platform) VALUES ($1, $2, $3)',
        [chatId, text, userState.platform]
      );
      
      await ctx.reply(
        `✅ *Ключ успешно сохранён!*\n\n` +
        `Платформа: *${userState.platformDisplay}*\n` +
        `Мы начали обработку ваших данных.\n` +
        `Вы получите уведомление когда анализ будет готов.\n\n` +
        `_Обычно это занимает 5-15 минут_`,
        { 
          parse_mode: 'Markdown',
          ...mainMenu 
        }
      );
      
      console.log(`✅ Ключ от ${chatId} сохранён для платформы ${userState.platform}`);
      
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
      userStates.delete(chatId);
      if (db) await db.end();
    }
  } else if (userState?.waitingForKey) {
    // Пользователь ввёл не ключ, а что-то другое
    await ctx.reply(
      'Это не похоже на API-ключ. Отправьте длинную строку (от 30 символов).',
      removeKeyboard
    );
  } else {
    // Не похоже на ключ и нет активного состояния - показываем меню
    await ctx.reply(
      'Пожалуйста, используйте кнопки меню.',
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
    console.log('✅ Бот запущен (версия 2.4)');
    
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
  console.log(`🤖 Версия: 2.4 (обновленное меню)`);
  
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