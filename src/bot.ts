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
  ['🎫 Оформить подписку на 30 дней'] // Новая кнопка
]).resize();

const adminMenu = Markup.keyboard([
  ['🔑 Отправить API-ключ'],
  ['📊 Мой статус', '🆘 Помощь'],
  ['📞 Связаться с поддержкой'],
  ['🎫 Оформить подписку на 30 дней'], // Новая кнопка
  ['⚡ Активировать подписку', '🆓 Активировать пробную версию']
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
    const result = await executeQuery(
      `SELECT subscription_status, subscription_expires_at 
       FROM api_keys 
       WHERE telegram_chat_id = $1 
       ORDER BY created_at DESC 
       LIMIT 1`,
      [chatId]
    );
    
    if (result.rows.length === 0) {
      return { 
        status: 'none',
        expiresAt: null,
        isValid: true, // ИЗМЕНЕНО: для тестирования всегда true
        message: 'Подписка не активирована (тестовый режим)'
      };
    }
    
    const row = result.rows[0];
    const status = row.subscription_status;
    const expiresAt = row.subscription_expires_at;
    
    // Если подписка истекла по времени
    if (expiresAt && new Date(expiresAt) < new Date()) {
      await executeQuery(
        `UPDATE api_keys 
         SET subscription_status = 'expired'
         WHERE telegram_chat_id = $1 AND subscription_status != 'expired'`,
        [chatId]
      );
      return {
        status: 'expired',
        expiresAt: expiresAt,
        isValid: true, // ИЗМЕНЕНО: для тестирования всегда true
        message: 'Подписка истекла (но в тестовом режиме всё работает)'
      };
    }
    
    // Проверяем валидность
    // ИЗМЕНЕНО: для тестирования всегда возвращаем true
    const isValid = true; // (status === 'active' || status === 'trial') && (!expiresAt || new Date(expiresAt) > new Date());
    
    let message = '';
    if (status === 'active' && isValid) {
      message = '✅ Подписка активна';
    } else if (status === 'trial' && isValid) {
      const daysLeft = Math.ceil((new Date(expiresAt) - new Date()) / (1000 * 60 * 60 * 24));
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
      isValid: true, // ИЗМЕНЕНО: для тестирования всегда true
      message: 'Ошибка проверки подписки (тестовый режим)'
    };
  }
}

/**
 * Активирует подписку на 30 дней
 */
async function activate30DaySubscription(chatId) {
  try {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30); // 30 дней
    
    // Проверяем, есть ли пользователь
    const existing = await executeQuery(
      `SELECT id FROM api_keys WHERE telegram_chat_id = $1`,
      [chatId]
    );
    
    if (existing.rows.length > 0) {
      // Обновляем существующую запись
      await executeQuery(
        `UPDATE api_keys 
         SET subscription_status = 'active', 
             subscription_expires_at = $1,
             updated_at = NOW()
         WHERE telegram_chat_id = $2`,
        [expiresAt, chatId]
      );
    } else {
      // Создаем новую запись (без API-ключа)
      await executeQuery(
        `INSERT INTO api_keys 
         (telegram_chat_id, subscription_status, subscription_expires_at, platform, created_at, updated_at) 
         VALUES ($1, $2, $3, $4, NOW(), NOW())`,
        [chatId, 'active', expiresAt, 'user']
      );
    }
    
    console.log(`✅ 30-дневная подписка активирована: ${chatId}`);
    
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
 * Активирует подписку для пользователя (админ)
 */
async function activateSubscription(targetChatId, type = 'active', adminName = '') {
  try {
    let expiresAt = null;
    
    if (type === 'trial') {
      expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 10); // 10 дней
    } else if (type === 'active') {
      expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30); // 30 дней
    }
    
    // Проверяем, есть ли пользователь
    const existing = await executeQuery(
      `SELECT id FROM api_keys WHERE telegram_chat_id = $1`,
      [targetChatId]
    );
    
    if (existing.rows.length > 0) {
      // Обновляем существующую запись
      await executeQuery(
        `UPDATE api_keys 
         SET subscription_status = $1, 
             subscription_expires_at = $2,
             updated_at = NOW()
         WHERE telegram_chat_id = $3`,
        [type, expiresAt, targetChatId]
      );
    } else {
      // Создаем новую запись (без API-ключа)
      await executeQuery(
        `INSERT INTO api_keys 
         (telegram_chat_id, subscription_status, subscription_expires_at, platform, created_at, updated_at) 
         VALUES ($1, $2, $3, $4, NOW(), NOW())`,
        [targetChatId, type, expiresAt, 'user']
      );
    }
    
    console.log(`✅ Подписка активирована: ${targetChatId} -> ${type}`);
    
    return {
      success: true,
      type: type,
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
 * Проверяет права администратора
 */
function isAdmin(chatId) {
  // Добавьте сюда chat_id администраторов
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
      version: '6.0',
      features: ['subscription-management', '30-day-subscription', 'test-mode-enabled']
    });
  } catch (error) {
    res.json({ 
      status: 'degraded', 
      bot: 'operational',
      database: 'disconnected',
      version: '6.0'
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
    
    let greeting = firstName ? `, ${firstName}!` : '!';
    let adminNote = isAdmin(chatId) ? '\n\n👑 *Вы администратор*' : '';
    let testNote = '\n\n⚠️ *Включен тестовый режим* - ключи принимаются без подписки';
    
    await ctx.reply(
      `*🔐 Skayfol Analytics*\n\n` +
      `Добро пожаловать${greeting}\n\n` +
      `📋 *Статус подписки:* ${subscription.message}${testNote}${adminNote}\n\n` +
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

// ========== НОВАЯ КНОПКА: ОФОРМИТЬ ПОДПИСКУ НА 30 ДНЕЙ ==========
bot.hears('🎫 Оформить подписку на 30 дней', async (ctx) => {
  const chatId = ctx.chat.id;
  const firstName = ctx.from.first_name || '';
  
  await ctx.reply(
    `*🎫 Оформление подписки на 30 дней*\n\n` +
    `Стоимость: *3000 руб.*\n` +
    `Срок действия: *30 дней*\n\n` +
    `Для оформления подписки:\n` +
    `1. Оплатите 3000 руб. на карту *xxxx xxxx xxxx xxxx*\n` +
    `2. Отправьте скриншот оплаты в поддержку\n` +
    `3. Мы активируем подписку в течение 24 часов\n\n` +
    `📞 *Контакты поддержки:*\n` +
    `📧 Email: support@skayfol.com\n` +
    `🌐 Сайт: https://skayfol.com`,
    { 
      parse_mode: 'Markdown',
      ...(isAdmin(chatId) ? adminMenu : mainMenu)
    }
  );
});

// ========== КНОПКИ УПРАВЛЕНИЯ ПОДПИСКАМИ (АДМИН) ==========
bot.hears('⚡ Активировать подписку', async (ctx) => {
  if (!isAdmin(ctx.chat.id)) {
    await ctx.reply('❌ Доступ только для администраторов', mainMenu);
    return;
  }
  
  await ctx.reply(
    'Введите *Telegram ID* для активации полной подписки (30 дней):\n' +
    '_Только цифры (пример: 7909570066)_',
    { parse_mode: 'Markdown', ...removeKeyboard }
  );
  
  ctx.session = { action: 'activate_subscription' };
});

bot.hears('🆓 Активировать пробную версию', async (ctx) => {
  if (!isAdmin(ctx.chat.id)) {
    await ctx.reply('❌ Доступ только для администраторов', mainMenu);
    return;
  }
  
  await ctx.reply(
    'Введите *Telegram ID* для активации пробной версии (10 дней):\n' +
    '_Только цифры (пример: 7909570066)_',
    { parse_mode: 'Markdown', ...removeKeyboard }
  );
  
  ctx.session = { action: 'activate_trial' };
});

// ========== ОБРАБОТКА ТЕКСТА ==========
bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  const chatId = ctx.chat.id;
  const firstName = ctx.from.first_name || '';
  
  // Пропускаем команды и кнопки
  const buttons = ['🔑 Отправить API-ключ', '📊 Мой статус', '🆘 Помощь', '📞 Связаться с поддержкой',
                  '🎫 Оформить подписку на 30 дней', '⚡ Активировать подписку', '🆓 Активировать пробную версию'];
  
  if (text.startsWith('/') || buttons.includes(text)) {
    return;
  }
  
  // Обработка активации подписки (админ)
  if (ctx.session?.action && (ctx.session.action === 'activate_subscription' || ctx.session.action === 'activate_trial')) {
    const targetChatId = parseInt(text);
    
    if (isNaN(targetChatId)) {
      await ctx.reply('❌ Некорректный ID. Введите только цифры.', adminMenu);
      return;
    }
    
    const subscriptionType = ctx.session.action === 'activate_subscription' ? 'active' : 'trial';
    const result = await activateSubscription(targetChatId, subscriptionType, firstName);
    
    if (result.success) {
      let msg = `✅ *Подписка активирована!*\n\n`;
      msg += `👤 Пользователь: ${targetChatId}\n`;
      msg += `📋 Тип: ${subscriptionType === 'active' ? 'Полная подписка (30 дней)' : 'Пробная версия (10 дней)'}\n`;
      
      if (result.expiresAt) {
        msg += `📅 Действует до: ${result.expiresAt.toLocaleDateString('ru-RU')}\n`;
      }
      
      await ctx.reply(msg, { parse_mode: 'Markdown', ...adminMenu });
      
      // Уведомляем пользователя
      try {
        await bot.telegram.sendMessage(
          targetChatId,
          `🎉 *Ваша подписка активирована!*\n\n` +
          `Тип: *${subscriptionType === 'active' ? 'Полная подписка (30 дней)' : 'Пробная версия (10 дней)'}*\n` +
          `Действует до: *${result.expiresAt.toLocaleDateString('ru-RU')}*\n\n` +
          `Теперь вы можете добавлять API-ключи!`,
          { parse_mode: 'Markdown', ...mainMenu }
        );
      } catch (error) {
        console.log(`⚠️ Не удалось уведомить пользователя ${targetChatId}`);
      }
    } else {
      await ctx.reply(
        `❌ Ошибка: ${result.error}`,
        adminMenu
      );
    }
    
    delete ctx.session;
    return;
  }
  
  // Проверка API-ключа (ТЕСТОВЫЙ РЕЖИМ - ПРОВЕРКА ОТКЛЮЧЕНА)
  if (text.length > 25 && /[a-zA-Z0-9._-]{25,}/.test(text)) {
    console.log(`🔑 Попытка сохранения ключа от ${chatId} (тестовый режим)`);
    
    // ⚠️ ЗАКОММЕНТИРОВАНА ПРОВЕРКА ПОДПИСКИ ДЛЯ ТЕСТИРОВАНИЯ ⚠️
    /*
    // Проверяем подписку
    const subscription = await checkUserSubscription(chatId);
    
    if (!subscription.isValid) {
      await ctx.reply(
        `❌ *Не удалось сохранить ключ*\n\n` +
        `${subscription.message}\n\n` +
        `Обратитесь к администратору для активации подписки.`,
        { parse_mode: 'Markdown', ...(isAdmin(chatId) ? adminMenu : mainMenu) }
      );
      return;
    }
    */
    
    // Проверка дубликата
    const duplicateCheck = await executeQuery(
      `SELECT created_at FROM api_keys 
       WHERE telegram_chat_id = $1 AND api_key = $2`,
      [chatId, text]
    );
    
    if (duplicateCheck.rows.length > 0) {
      const savedAt = new Date(duplicateCheck.rows[0].created_at).toLocaleString('ru-RU');
      await ctx.reply(
        `⚠️ *Этот ключ уже сохранен!*\n\n` +
        `Дата: ${savedAt}`,
        { parse_mode: 'Markdown', ...(isAdmin(chatId) ? adminMenu : mainMenu) }
      );
      return;
    }
    
    // Сохраняем ключ
    try {
      await executeQuery(
        `INSERT INTO api_keys 
         (telegram_chat_id, api_key, platform, created_at, updated_at) 
         VALUES ($1, $2, $3, NOW(), NOW())`,
        [chatId, text, 'api_key_saved']
      );
      
      console.log(`✅ Ключ сохранен в БД для пользователя ${chatId}`);
      
      await ctx.reply(
        `✅ *Ключ успешно сохранен!*\n\n` +
        `🔑 *Статус:* Принят в обработку\n` +
        `⏰ *Время:* ${new Date().toLocaleString('ru-RU')}\n\n` +
        `Мы начали анализ ваших данных. Результаты будут готовы в течение 5-15 минут.`,
        { parse_mode: 'Markdown', ...(isAdmin(chatId) ? adminMenu : mainMenu) }
      );
      
    } catch (error) {
      console.error('❌ Ошибка сохранения ключа:', error.message);
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
        '⚠️ *ТЕСТОВЫЙ РЕЖИМ:* Ключи принимаются без подписки',
    { parse_mode: 'Markdown', ...removeKeyboard }
  );
});

bot.hears('📊 Мой статус', async (ctx) => {
  const chatId = ctx.chat.id;
  const firstName = ctx.from.first_name || '';
  
  try {
    const subscription = await checkUserSubscription(chatId);
    
    const stats = await executeQuery(
      `SELECT COUNT(*) as total_keys, 
              MAX(created_at) as last_key_added
       FROM api_keys 
       WHERE telegram_chat_id = $1 AND api_key IS NOT NULL`,
      [chatId]
    );
    
    const totalKeys = stats.rows[0].total_keys || 0;
    const lastKeyAdded = stats.rows[0].last_key_added 
      ? new Date(stats.rows[0].last_key_added).toLocaleString('ru-RU')
      : 'ещё нет';
    
    let msg = `*📊 Ваша статистика${firstName ? ', ' + firstName : ''}*\n\n`;
    msg += `👤 *Telegram ID:* ${chatId}\n`;
    msg += `📋 *Статус подписки:* ${subscription.message}\n`;
    
    if (subscription.expiresAt) {
      msg += `📅 *Действует до:* ${new Date(subscription.expiresAt).toLocaleDateString('ru-RU')}\n`;
    }
    
    msg += `\n🔑 *Ключей сохранено:* ${totalKeys}\n`;
    msg += `⏰ *Последний ключ:* ${lastKeyAdded}\n\n`;
    msg += `⚙️ *Режим работы:* Тестовый (все операции разрешены)`;
    
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
    `_Ответ в течение 24 часов_\n\n` +
    `*По вопросам:*\n` +
    `• Активации подписки\n` +
    `• Проблем с API-ключами\n` +
    `• Технической поддержки`,
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
    console.log('⚠️ ПРОВЕРКА ПОДПИСОК ОТКЛЮЧЕНА');
    console.log('✅ API-ключи принимаются без ограничений');
  } catch (error) {
    console.error('❌ Ошибка запуска:', error.message);
    setTimeout(startBot, 10000);
  }
}

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Сервер на порту ${PORT}`);
  console.log(`🤖 Версия: 6.0 (тестовый режим)`);
  console.log(`📊 API эндпоинты:`);
  console.log(`   POST /api/send-message`);
  console.log(`   GET  /health`);
  console.log(`\n⚙️  РЕЖИМ РАБОТЫ:`);
  console.log(`   ✅ Прием API-ключей: ВКЛЮЧЕН`);
  console.log(`   ⚠️ Проверка подписок: ОТКЛЮЧЕНА`);
  console.log(`   👑 Админ-панель: ДОСТУПНА`);
  
  setTimeout(startBot, 2000);
});

process.on('SIGTERM', () => {
  console.log('🛑 Завершение работы...');
  bot.stop();
  server.close();
  process.exit(0);
});

console.log('🚀 Бот инициализирован в тестовом режиме');