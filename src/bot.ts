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
  ['📞 Связаться с поддержкой'],
  ['🎫 Оформить подписку на 30 дней']
]).resize();

const adminMenu = Markup.keyboard([
  ['🔑 Отправить API-ключ'],
  ['📊 Мой статус', '🆘 Помощь'],
  ['📞 Связаться с поддержкой'],
  ['🎫 Оформить подписку на 30 дней'],
  ['⚡ Активировать подписку'] // Убрана кнопка пробной версии
]).resize();

const removeKeyboard = Markup.removeKeyboard();

// ========== ПОДКЛЮЧЕНИЕ К БД ==========
async function getDbConnection(retries = 3, delay = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      const db = new Client({ 
        connectionString: DB_URL,
        ssl: { rejectUnauthorized: false }
      });
      
      await db.connect();
      return db;
      
    } catch (error) {
      console.error(`❌ Ошибка подключения к БД (попытка ${i + 1}/${retries}):`, error.message);
      
      if (i < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }
}

async function executeQuery(query, params = []) {
  let db;
  try {
    db = await getDbConnection();
    const result = await db.query(query, params);
    return result;
  } finally {
    if (db) {
      try {
        await db.end();
      } catch (error) {
        // Игнорируем ошибки закрытия
      }
    }
  }
}

// ========== ФУНКЦИИ ДЛЯ ПОДПИСОК ==========

/**
 * Проверяет подписку пользователя
 */
async function checkUserSubscription(chatId) {
  try {
    // Пытаемся использовать telegram_chat_id если он есть, иначе chat_id
    const structureCheck = await executeQuery(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'api_keys' 
      AND column_name IN ('telegram_chat_id', 'chat_id')
    `);
    
    const hasTelegramChatId = structureCheck.rows.some(row => row.column_name === 'telegram_chat_id');
    const hasChatId = structureCheck.rows.some(row => row.column_name === 'chat_id');
    
    let queryField = hasTelegramChatId ? 'telegram_chat_id' : 'chat_id';
    
    // Проверяем наличие полей подписки
    const subscriptionFieldsCheck = await executeQuery(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'api_keys' 
      AND column_name IN ('subscription_status', 'subscription_expires_at')
    `);
    
    const hasSubscriptionStatus = subscriptionFieldsCheck.rows.some(row => row.column_name === 'subscription_status');
    const hasSubscriptionExpiresAt = subscriptionFieldsCheck.rows.some(row => row.column_name === 'subscription_expires_at');
    
    if (!hasSubscriptionStatus) {
      // Если поля подписки нет, возвращаем тестовый режим
      return { 
        status: 'none',
        expiresAt: null,
        isValid: true, // Для тестирования всегда true
        message: 'Тестовый режим (подписки отключены)'
      };
    }
    
    const result = await executeQuery(
      `SELECT subscription_status, subscription_expires_at 
       FROM api_keys 
       WHERE ${queryField} = $1 
       ORDER BY created_at DESC 
       LIMIT 1`,
      [chatId]
    );
    
    if (result.rows.length === 0) {
      return { 
        status: 'none',
        expiresAt: null,
        isValid: true, // Для тестирования всегда true
        message: 'Тестовый режим (подписки отключены)'
      };
    }
    
    const row = result.rows[0];
    const status = row.subscription_status;
    const expiresAt = row.subscription_expires_at;
    
    // Для тестирования всегда возвращаем true
    const isValid = true;
    
    let message = '';
    if (status === 'active' && isValid) {
      message = '✅ Подписка активна';
      if (expiresAt) {
        const expiresDate = new Date(expiresAt).toLocaleDateString('ru-RU');
        message += ` (до ${expiresDate})`;
      }
    } else if (status === 'trial' && isValid) {
      const daysLeft = expiresAt ? Math.ceil((new Date(expiresAt) - new Date()) / (1000 * 60 * 60 * 24)) : 0;
      message = `🆓 Пробная версия (осталось ${daysLeft} дней)`;
    } else if (status === 'expired') {
      message = '❌ Подписка истекла (тестовый режим)';
    } else if (!status || status === 'none') {
      message = '⏳ Подписка не активирована (тестовый режим)';
    } else {
      message = `Статус: ${status} (тестовый режим)`;
    }
    
    return {
      status: status || 'none',
      expiresAt: expiresAt,
      isValid: isValid,
      message: message
    };
    
  } catch (error) {
    console.error('❌ Ошибка проверки подписки:', error.message);
    return { 
      status: 'error',
      expiresAt: null,
      isValid: true, // Для тестирования всегда true
      message: 'Тестовый режим (ошибка проверки)'
    };
  }
}

/**
 * Активирует подписку на 30 дней для пользователя (админ)
 */
async function activate30DaySubscription(targetChatId, adminName = '') {
  try {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30); // 30 дней
    
    // Проверяем структуру таблицы
    const structureCheck = await executeQuery(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'api_keys' 
      AND column_name IN ('telegram_chat_id', 'chat_id')
    `);
    
    const hasTelegramChatId = structureCheck.rows.some(row => row.column_name === 'telegram_chat_id');
    const queryField = hasTelegramChatId ? 'telegram_chat_id' : 'chat_id';
    
    // Проверяем наличие полей подписки
    const subscriptionFieldsCheck = await executeQuery(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'api_keys' 
      AND column_name IN ('subscription_status', 'subscription_expires_at')
    `);
    
    const hasSubscriptionStatus = subscriptionFieldsCheck.rows.some(row => row.column_name === 'subscription_status');
    
    if (!hasSubscriptionStatus) {
      return {
        success: false,
        error: 'Поля подписки отсутствуют в БД'
      };
    }
    
    // Проверяем, есть ли пользователь
    const existing = await executeQuery(
      `SELECT id FROM api_keys WHERE ${queryField} = $1`,
      [targetChatId]
    );
    
    if (existing.rows.length > 0) {
      // Обновляем существующую запись
      await executeQuery(
        `UPDATE api_keys 
         SET subscription_status = 'active', 
             subscription_expires_at = $1,
             updated_at = NOW()
         WHERE ${queryField} = $2`,
        [expiresAt, targetChatId]
      );
    } else {
      // Создаем новую запись
      await executeQuery(
        `INSERT INTO api_keys 
         (${queryField}, subscription_status, subscription_expires_at, platform, created_at, updated_at) 
         VALUES ($1, $2, $3, $4, NOW(), NOW())`,
        [targetChatId, 'active', expiresAt, 'user']
      );
    }
    
    console.log(`✅ 30-дневная подписка активирована: ${targetChatId}`);
    
    return {
      success: true,
      expiresAt: expiresAt
    };
    
  } catch (error) {
    console.error('❌ Ошибка активации подписки:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Сохраняет API-ключ (без проверки подписок)
 */
async function saveApiKey(chatId, apiKeyText) {
  try {
    // Проверяем структуру таблицы
    const structureCheck = await executeQuery(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'api_keys' 
      AND column_name IN ('telegram_chat_id', 'chat_id')
    `);
    
    const hasTelegramChatId = structureCheck.rows.some(row => row.column_name === 'telegram_chat_id');
    const queryField = hasTelegramChatId ? 'telegram_chat_id' : 'chat_id';
    
    // Проверяем дубликат
    const duplicateCheck = await executeQuery(
      `SELECT created_at FROM api_keys 
       WHERE ${queryField} = $1 AND api_key = $2`,
      [chatId, apiKeyText]
    );
    
    if (duplicateCheck.rows.length > 0) {
      const savedAt = new Date(duplicateCheck.rows[0].created_at).toLocaleString('ru-RU');
      return {
        success: false,
        reason: 'duplicate_key',
        savedAt: savedAt
      };
    }
    
    // Сохраняем ключ
    await executeQuery(
      `INSERT INTO api_keys 
       (${queryField}, api_key, platform, created_at, updated_at) 
       VALUES ($1, $2, $3, NOW(), NOW())`,
      [chatId, apiKeyText, 'api_key_saved']
    );
    
    console.log(`✅ Ключ сохранен: ${chatId}`);
    return {
      success: true
    };
    
  } catch (error) {
    console.error('❌ Ошибка сохранения ключа:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Получает статистику пользователя
 */
async function getUserStats(chatId) {
  try {
    // Проверяем структуру таблицы
    const structureCheck = await executeQuery(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'api_keys' 
      AND column_name IN ('telegram_chat_id', 'chat_id')
    `);
    
    const hasTelegramChatId = structureCheck.rows.some(row => row.column_name === 'telegram_chat_id');
    const queryField = hasTelegramChatId ? 'telegram_chat_id' : 'chat_id';
    
    const result = await executeQuery(
      `SELECT COUNT(*) as total_keys, 
              MAX(created_at) as last_key_added
       FROM api_keys 
       WHERE ${queryField} = $1 AND api_key IS NOT NULL`,
      [chatId]
    );
    
    return {
      totalKeys: result.rows[0].total_keys || 0,
      lastKeyAdded: result.rows[0].last_key_added 
        ? new Date(result.rows[0].last_key_added).toLocaleString('ru-RU')
        : 'ещё нет'
    };
    
  } catch (error) {
    console.error('❌ Ошибка получения статистики:', error.message);
    return {
      totalKeys: 0,
      lastKeyAdded: 'ошибка'
    };
  }
}

/**
 * Проверяет права администратора
 */
function isAdmin(chatId) {
  const adminIds = [7909570066]; // Ваш chat_id
  return adminIds.includes(chatId);
}

// ========== API ЭНДПОИНТЫ ==========
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
    
  } catch (error) {
    console.error('❌ [WEBHOOK] Ошибка:', error.message);
    res.status(500).json({ error: 'Ошибка отправки' });
  }
});

app.get('/health', async (req, res) => {
  try {
    await executeQuery('SELECT 1 as status');
    res.json({ 
      status: 'ok', 
      bot: 'operational',
      database: 'connected',
      version: '7.1',
      features: ['api-keys-save', '30-day-subscription-info', 'test-mode']
    });
  } catch (error) {
    res.json({ 
      status: 'degraded', 
      bot: 'operational',
      database: 'disconnected',
      version: '7.1'
    });
  }
});

// ========== КОМАНДА /start ==========
bot.start(async (ctx) => {
  const chatId = ctx.chat.id;
  const firstName = ctx.from.first_name || '';
  
  console.log(`🚀 /start от ${chatId} (${firstName})`);
  
  try {
    const subscription = await checkUserSubscription(chatId);
    const menuToShow = isAdmin(chatId) ? adminMenu : mainMenu;
    
    const greeting = firstName ? `, ${firstName}!` : '!';
    const adminNote = isAdmin(chatId) ? '\n\n👑 *Вы администратор*' : '';
    
    await ctx.reply(
      `*🔐 Skayfol Analytics*\n\n` +
      `Добро пожаловать${greeting}\n\n` +
      `📋 *Статус:* ${subscription.message}${adminNote}\n\n` +
      `Выберите действие:`,
      { 
        parse_mode: 'Markdown',
        ...menuToShow 
      }
    );
    
  } catch (error) {
    console.error('❌ Ошибка при старте:', error.message);
    await ctx.reply(
      `Добро пожаловать! Выберите действие:`,
      mainMenu
    );
  }
});

// ========== КНОПКА: ОФОРМИТЬ ПОДПИСКУ НА 30 ДНЕЙ ==========
bot.hears('🎫 Оформить подписку на 30 дней', async (ctx) => {
  await ctx.reply(
    `*🎫 Оформление подписки на 30 дней*\n\n` +
    `Стоимость: *3000 руб.*\n` +
    `Срок действия: *30 дней*\n\n` +
    `Для оформления подписки:\n` +
    `1. Оплатите 3000 руб.\n` +
    `2. Отправьте скриншот оплаты в поддержку\n` +
    `3. Мы активируем подписку в течение 24 часов\n\n` +
    `📞 *Контакты поддержки:*\n` +
    `📧 Email: support@skayfol.com\n` +
    `🌐 Сайт: https://skayfol.com`,
    { 
      parse_mode: 'Markdown',
      ...(isAdmin(ctx.chat.id) ? adminMenu : mainMenu)
    }
  );
});

// ========== КНОПКА: АКТИВИРОВАТЬ ПОДПИСКУ (АДМИН) ==========
bot.hears('⚡ Активировать подписку', async (ctx) => {
  const chatId = ctx.chat.id;
  
  if (!isAdmin(chatId)) {
    await ctx.reply('❌ Доступ только для администраторов', mainMenu);
    return;
  }
  
  await ctx.reply(
    'Введите *Telegram ID* для активации подписки на 30 дней:\n' +
    '_Только цифры (пример: 7909570066)_',
    { parse_mode: 'Markdown', ...removeKeyboard }
  );
  
  ctx.session = { action: 'activate_subscription' };
});

// ========== ОБРАБОТКА ТЕКСТА ==========
bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  const chatId = ctx.chat.id;
  const firstName = ctx.from.first_name || '';
  
  // Пропускаем команды и кнопки
  const buttons = ['🔑 Отправить API-ключ', '📊 Мой статус', '🆘 Помощь', 
                  '📞 Связаться с поддержкой', '🎫 Оформить подписку на 30 дней',
                  '⚡ Активировать подписку']; // Убрана кнопка пробной версии
  
  if (text.startsWith('/') || buttons.includes(text)) {
    return;
  }
  
  // Обработка активации подписки (админ)
  if (ctx.session?.action && ctx.session.action === 'activate_subscription') {
    const targetChatId = parseInt(text);
    
    if (isNaN(targetChatId)) {
      await ctx.reply('❌ Некорректный ID. Введите только цифры.', adminMenu);
      return;
    }
    
    const result = await activate30DaySubscription(targetChatId, firstName);
    
    if (result.success) {
      let msg = `✅ *Подписка активирована!*\n\n`;
      msg += `👤 Пользователь: ${targetChatId}\n`;
      msg += `📋 Тип: Полная подписка (30 дней)\n`;
      msg += `📅 Действует до: ${result.expiresAt.toLocaleDateString('ru-RU')}\n\n`;
      msg += `_Активировано администратором: ${firstName || 'админ'}_`;
      
      await ctx.reply(msg, { parse_mode: 'Markdown', ...adminMenu });
      
      // Уведомляем пользователя
      try {
        await bot.telegram.sendMessage(
          targetChatId,
          `🎉 *Ваша подписка активирована!*\n\n` +
          `Тип: *Полная подписка (30 дней)*\n` +
          `Действует до: *${result.expiresAt.toLocaleDateString('ru-RU')}*\n\n` +
          `Теперь вы можете добавлять API-ключи!`,
          { parse_mode: 'Markdown', ...mainMenu }
        );
      } catch (error) {
        console.log(`⚠️ Не удалось уведомить пользователя ${targetChatId}`);
      }
    } else {
      await ctx.reply(
        `❌ Ошибка: ${result.error}\n\n` +
        `Возможно, поля подписки отсутствуют в БД.`,
        adminMenu
      );
    }
    
    delete ctx.session;
    return;
  }
  
  // Проверка API-ключа
  if (text.length > 25 && /[a-zA-Z0-9._-]{25,}/.test(text)) {
    console.log(`🔑 Попытка сохранения ключа от ${chatId}`);
    
    const result = await saveApiKey(chatId, text);
    
    if (result.success) {
      await ctx.reply(
        `✅ *Ключ успешно сохранен!*\n\n` +
        `🔑 *Статус:* Принят в обработку\n` +
        `⏰ *Время:* ${new Date().toLocaleString('ru-RU')}\n\n` +
        `Анализ данных начат. Результаты будут готовы в течение 5-15 минут.`,
        { parse_mode: 'Markdown', ...(isAdmin(chatId) ? adminMenu : mainMenu) }
      );
      
    } else if (result.reason === 'duplicate_key') {
      const savedAt = result.savedAt;
      await ctx.reply(
        `⚠️ *Этот ключ уже сохранен!*\n\n` +
        `Дата сохранения: ${savedAt}`,
        { parse_mode: 'Markdown', ...(isAdmin(chatId) ? adminMenu : mainMenu) }
      );
      
    } else {
      await ctx.reply(
        `❌ *Ошибка сохранения ключа*\n\n` +
        `Пожалуйста, попробуйте позже или обратитесь в поддержку.`,
        { parse_mode: 'Markdown', ...(isAdmin(chatId) ? adminMenu : mainMenu) }
      );
    }
    
  } else {
    // Не ключ
    await ctx.reply(
      'Используйте кнопки меню или отправьте API-ключ.',
      isAdmin(chatId) ? adminMenu : mainMenu
    );
  }
});

// ========== ОСТАЛЬНЫЕ КНОПКИ ==========
bot.hears('🔑 Отправить API-ключ', async (ctx) => {
  await ctx.reply(
    'Отправьте API-ключ одной строкой (от 30 символов):\n\n' +
    '✅ *ТЕСТОВЫЙ РЕЖИМ:* Ключи принимаются без ограничений',
    { parse_mode: 'Markdown', ...removeKeyboard }
  );
});

bot.hears('📊 Мой статус', async (ctx) => {
  const chatId = ctx.chat.id;
  const firstName = ctx.from.first_name || '';
  
  try {
    const subscription = await checkUserSubscription(chatId);
    const stats = await getUserStats(chatId);
    
    let msg = `*📊 Ваша статистика${firstName ? ', ' + firstName : ''}*\n\n`;
    msg += `👤 *Telegram ID:* ${chatId}\n`;
    msg += `📋 *Статус подписки:* ${subscription.message}\n`;
    
    if (subscription.expiresAt) {
      msg += `📅 *Действует до:* ${new Date(subscription.expiresAt).toLocaleDateString('ru-RU')}\n`;
    }
    
    msg += `\n🔑 *Ключей сохранено:* ${stats.totalKeys}\n`;
    msg += `⏰ *Последний ключ:* ${stats.lastKeyAdded}\n\n`;
    msg += `⚙️ *Режим работы:* Тестовый`;
    
    await ctx.reply(
      msg,
      { parse_mode: 'Markdown', ...(isAdmin(chatId) ? adminMenu : mainMenu) }
    );
    
  } catch (error) {
    console.error('❌ Ошибка получения статуса:', error.message);
    await ctx.reply(
      `⚠️ Ошибка получения статуса. Пожалуйста, попробуйте позже.`,
      isAdmin(chatId) ? adminMenu : mainMenu
    );
  }
});

bot.hears('🆘 Помощь', async (ctx) => {
  await ctx.reply(
    `*❓ Помощь и поддержка*\n\n` +
    `🔹 *Как отправить API-ключ?*\n` +
    `Нажмите "🔑 Отправить API-ключ" и отправьте ключ\n\n` +
    `🔹 *Как оформить подписку?*\n` +
    `Нажмите "🎫 Оформить подписку на 30 дней"\n\n` +
    `🔹 *Текущий режим:*\n` +
    `✅ Тестовый - ключи принимаются без подписки\n\n` +
    `🔹 *Контакты поддержки:*\n` +
    `📧 support@skayfol.com\n` +
    `🌐 https://skayfol.com`,
    { parse_mode: 'Markdown', ...(isAdmin(ctx.chat.id) ? adminMenu : mainMenu) }
  );
});

bot.hears('📞 Связаться с поддержкой', async (ctx) => {
  await ctx.reply(
    `*📞 Контакты поддержки*\n\n` +
    `📧 *Email:* support@skayfol.com\n` +
    `🌐 *Сайт:* https://skayfol.com\n` +
    `⏰ *Часы работы:* 9:00-18:00 (МСК)\n\n` +
    `_Ответ в течение 24 часов_`,
    { parse_mode: 'Markdown', ...(isAdmin(ctx.chat.id) ? adminMenu : mainMenu) }
  );
});

// ========== ЗАПУСК ==========
bot.use((ctx, next) => {
  if (!ctx.session) ctx.session = {};
  return next();
});

async function startBot() {
  try {
    await bot.telegram.deleteWebhook();
    await bot.launch();
    console.log('✅ Бот запущен в тестовом режиме');
    console.log('⚙️  РЕЖИМ РАБОТЫ:');
    console.log('   ✅ Прием API-ключей: ВКЛЮЧЕН');
    console.log('   🎫 Подписка на 30 дней: ИНФОРМАЦИЯ');
    console.log('   👑 Админ-панель: ДОСТУПНА (без пробной версии)');
    
  } catch (error) {
    console.error('❌ Ошибка запуска:', error.message);
    setTimeout(startBot, 10000);
  }
}

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Сервер на порту ${PORT}`);
  console.log(`🤖 Версия: 7.1 (без пробной версии)`);
  console.log(`📊 API эндпоинты:`);
  console.log(`   POST /api/send-message`);
  console.log(`   GET  /health`);
  
  setTimeout(startBot, 2000);
});

process.on('SIGTERM', () => {
  console.log('🛑 Завершение работы...');
  bot.stop();
  server.close();
  process.exit(0);
});

console.log('🚀 Бот инициализирован (без кнопки пробной версии)');