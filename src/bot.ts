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

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==========

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

/**
 * Сохраняет информацию о пользователе при /start
 * Имя сохраняем в поле platform или создаем новую таблицу для пользователей
 */
async function saveUserInfo(chatId, firstName, lastName = '', username = '') {
  try {
    // Сначала проверяем структуру таблицы
    const structure = await executeQuery(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'api_keys'
    `);
    
    const columns = structure.rows.map(row => row.column_name);
    const hasFirstName = columns.includes('first_name');
    const hasLastName = columns.includes('last_name');
    const hasUsername = columns.includes('username');
    
    // Формируем полное имя
    const fullName = `${firstName}${lastName ? ' ' + lastName : ''}`;
    
    // Сохраняем в зависимости от структуры таблицы
    if (hasFirstName && hasLastName) {
      // Есть отдельные поля для имени
      await executeQuery(
        `INSERT INTO api_keys 
         (chat_id, first_name, last_name, username, platform, created_at, updated_at) 
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
         ON CONFLICT (chat_id) DO UPDATE SET
         first_name = $2, last_name = $3, username = $4, platform = $5, updated_at = NOW()`,
        [chatId, firstName, lastName, username, 'telegram_user']
      );
    } else if (columns.includes('user_info')) {
      // Есть поле user_info (JSON)
      const userInfo = JSON.stringify({
        first_name: firstName,
        last_name: lastName,
        username: username,
        full_name: fullName
      });
      
      await executeQuery(
        `INSERT INTO api_keys 
         (chat_id, user_info, platform, created_at, updated_at) 
         VALUES ($1, $2, $3, NOW(), NOW())
         ON CONFLICT (chat_id) DO UPDATE SET
         user_info = $2, platform = $3, updated_at = NOW()`,
        [chatId, userInfo, 'telegram_user']
      );
    } else {
      // Сохраняем имя в поле platform
      await executeQuery(
        `INSERT INTO api_keys 
         (chat_id, platform, created_at, updated_at) 
         VALUES ($1, $2, NOW(), NOW())
         ON CONFLICT (chat_id) DO UPDATE SET
         platform = $2, updated_at = NOW()`,
        [chatId, `user:${fullName}`]
      );
    }
    
    console.log(`✅ Информация о пользователе сохранена: ${fullName} (${chatId})`);
    return true;
    
  } catch (error) {
    console.error('❌ Ошибка сохранения информации о пользователе:', error.message);
    return false;
  }
}

/**
 * Проверяет подписку пользователя
 * Для совместимости используем поле platform для хранения статуса подписки
 */
async function checkUserSubscription(chatId) {
  try {
    // Сначала пробуем получить статус из поля subscription_status
    const result = await executeQuery(
      `SELECT platform, created_at 
       FROM api_keys 
       WHERE chat_id = $1 
       ORDER BY created_at DESC 
       LIMIT 1`,
      [chatId]
    );
    
    if (result.rows.length === 0) {
      return { 
        isValid: false, // Новый пользователь - нет подписки
        status: 'new_user',
        expiresAt: null,
        message: 'Новый пользователь. Требуется активация подписки.'
      };
    }
    
    const row = result.rows[0];
    const platform = row.platform || '';
    const createdAt = new Date(row.created_at);
    const now = new Date();
    
    // Проверяем разные варианты хранения статуса в поле platform
    if (platform.includes('subscription:active') || platform.includes('status:active')) {
      return {
        isValid: true,
        status: 'active',
        expiresAt: null,
        message: 'Подписка активна'
      };
    } else if (platform.includes('subscription:trial') || platform.includes('status:trial')) {
      // Проверяем не истек ли триал (14 дней)
      const trialDays = 14;
      const trialExpires = new Date(createdAt);
      trialExpires.setDate(trialExpires.getDate() + trialDays);
      
      const isValid = now < trialExpires;
      
      return {
        isValid: isValid,
        status: isValid ? 'trial' : 'trial_expired',
        expiresAt: trialExpires,
        message: isValid ? `Триал активен до ${trialExpires.toLocaleDateString('ru-RU')}` : 'Триал истек'
      };
    } else if (platform.includes('subscription:expired') || platform.includes('status:expired')) {
      return {
        isValid: false,
        status: 'expired',
        expiresAt: null,
        message: 'Подписка истекла'
      };
    }
    
    // Если статус не указан - считаем что подписка не активирована
    return {
      isValid: false,
      status: 'inactive',
      expiresAt: null,
      message: 'Подписка не активирована'
    };
    
  } catch (error) {
    console.error('❌ Ошибка проверки подписки:', error.message);
    return {
      isValid: false,
      status: 'error',
      expiresAt: null,
      message: 'Ошибка проверки подписки'
    };
  }
}

/**
 * Обновляет статус подписки пользователя
 */
async function updateSubscriptionStatus(chatId, status, expiresAt = null) {
  try {
    let platformValue = '';
    
    switch (status) {
      case 'active':
        platformValue = 'subscription:active';
        break;
      case 'trial':
        platformValue = 'subscription:trial';
        break;
      case 'expired':
        platformValue = 'subscription:expired';
        break;
      default:
        platformValue = `subscription:${status}`;
    }
    
    if (expiresAt) {
      platformValue += `:expires:${expiresAt.toISOString()}`;
    }
    
    await executeQuery(
      `UPDATE api_keys 
       SET platform = $1, updated_at = NOW() 
       WHERE chat_id = $2`,
      [platformValue, chatId]
    );
    
    console.log(`✅ Статус подписки обновлен: ${chatId} -> ${status}`);
    return true;
    
  } catch (error) {
    console.error('❌ Ошибка обновления статуса подписки:', error.message);
    return false;
  }
}

/**
 * Сохраняет API-ключ с проверкой подписки
 */
async function saveApiKeyWithCheck(chatId, apiKeyText, firstName) {
  try {
    // Проверяем подписку
    const subscription = await checkUserSubscription(chatId);
    
    if (!subscription.isValid) {
      return {
        success: false,
        reason: 'subscription_invalid',
        message: `❌ *Не удалось сохранить ключ*\n\n` +
                `${subscription.message}\n\n` +
                `📞 Для активации подписки свяжитесь с поддержкой:\n` +
                `📧 support@skayfol.com`
      };
    }
    
    // Проверяем дубликат
    const duplicateCheck = await executeQuery(
      `SELECT created_at FROM api_keys 
       WHERE chat_id = $1 AND api_key = $2 
       AND api_key IS NOT NULL`,
      [chatId, apiKeyText]
    );
    
    if (duplicateCheck.rows.length > 0) {
      const savedAt = new Date(duplicateCheck.rows[0].created_at).toLocaleString('ru-RU');
      return {
        success: false,
        reason: 'duplicate_key',
        message: `⚠️ *Этот ключ уже был сохранён!*\n\n` +
                `_Дата сохранения: ${savedAt}_\n\n` +
                `Если нужно обновить ключ - свяжитесь с поддержкой.`
      };
    }
    
    // Сохраняем ключ
    await executeQuery(
      `INSERT INTO api_keys 
       (chat_id, api_key, platform, created_at, updated_at) 
       VALUES ($1, $2, $3, NOW(), NOW())`,
      [chatId, apiKeyText, 'api_key_saved']
    );
    
    // Обновляем информацию о пользователе (если имя есть)
    if (firstName) {
      await saveUserInfo(chatId, firstName);
    }
    
    return {
      success: true,
      message: `✅ *Ключ успешно сохранён, ${firstName || 'пользователь'}!*\n\n` +
              `Мы начали обработку ваших данных.\n` +
              `Вы получите уведомление когда анализ будет готов.\n\n` +
              `_Обычно это занимает 5-15 минут_`
    };
    
  } catch (error) {
    console.error('❌ Ошибка сохранения ключа:', error.message);
    return {
      success: false,
      reason: 'database_error',
      message: '⚠️ *Ошибка сервера*\n\nПожалуйста, попробуйте позже.'
    };
  }
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

// Эндпоинт для установки статуса подписки
app.post('/api/user/:chat_id/subscription', async (req, res) => {
  try {
    const chatId = parseInt(req.params.chat_id);
    const { status, expires_at } = req.body;
    
    if (isNaN(chatId) || !status) {
      return res.status(400).json({ error: 'Нужны chat_id и status' });
    }
    
    const expiresAt = expires_at ? new Date(expires_at) : null;
    const success = await updateSubscriptionStatus(chatId, status, expiresAt);
    
    if (success) {
      res.json({ 
        success: true, 
        message: `Статус подписки для ${chatId} установлен: ${status}` 
      });
    } else {
      res.status(500).json({ error: 'Ошибка обновления статуса' });
    }
    
  } catch (error) {
    console.error('❌ [API] Ошибка обновления подписки:', error);
    res.status(500).json({ error: error.message });
  }
});

// Проверка статуса подписки
app.get('/api/user/:chat_id/status', async (req, res) => {
  try {
    const chatId = parseInt(req.params.chat_id);
    
    if (isNaN(chatId)) {
      return res.status(400).json({ error: 'Некорректный chat_id' });
    }
    
    const subscription = await checkUserSubscription(chatId);
    
    res.json({
      telegram_chat_id: chatId,
      subscription_status: subscription.status,
      is_valid: subscription.isValid,
      message: subscription.message,
      expires_at: subscription.expiresAt
    });
    
  } catch (error) {
    console.error('❌ [API] Ошибка проверки статуса:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.get('/health', async (req, res) => {
  try {
    await executeQuery('SELECT 1 as status');
    res.json({ 
      status: 'ok', 
      bot: 'operational',
      database: 'connected',
      version: '4.0',
      features: ['subscription-check', 'user-info', 'api-keys']
    });
  } catch (error) {
    res.json({ 
      status: 'degraded', 
      bot: 'operational',
      database: 'disconnected',
      version: '4.0'
    });
  }
});

// ========== КОМАНДА /start ==========
bot.start(async (ctx) => {
  const chatId = ctx.chat.id;
  const firstName = ctx.from.first_name || '';
  const lastName = ctx.from.last_name || '';
  const username = ctx.from.username || '';
  
  console.log(`🚀 /start от ${chatId} (${firstName} ${lastName} @${username})`);
  
  try {
    // Сохраняем информацию о пользователе
    await saveUserInfo(chatId, firstName, lastName, username);
    
    // Проверяем подписку
    const subscription = await checkUserSubscription(chatId);
    
    let subscriptionMessage = '';
    if (subscription.isValid) {
      subscriptionMessage = `\n✅ *Ваша подписка активна*`;
      if (subscription.expiresAt) {
        const expiresDate = subscription.expiresAt.toLocaleDateString('ru-RU');
        subscriptionMessage += ` (до ${expiresDate})`;
      }
    } else {
      subscriptionMessage = `\n⚠️ *${subscription.message}*`;
    }
    
    // Приветственное сообщение с именем
    const greeting = firstName ? `, ${firstName}!` : '!';
    
    await ctx.reply(
      `*🔐 Skayfol Analytics*\n\n` +
      `Добро пожаловать в систему аналитики рекламных кампаний${greeting}\n\n` +
      `${subscriptionMessage}\n\n` +
      `*Что умеет бот:*\n` +
      `✅ Сохраняет ваши API-ключи\n` +
      `✅ Проверяет статус подписки\n` +
      `✅ Уведомляет о результатах анализа\n\n` +
      `Выберите действие:`,
      { 
        parse_mode: 'Markdown',
        ...mainMenu 
      }
    );
    
  } catch (error) {
    console.error('❌ Ошибка при старте:', error.message);
    
    // Простое приветствие при ошибке
    const greeting = firstName ? `, ${firstName}!` : '!';
    await ctx.reply(
      `Привет${greeting} Добро пожаловать в Skayfol Analytics!\n\n` +
      `Выберите действие:`,
      mainMenu
    );
  }
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
  const chatId = ctx.chat.id;
  const firstName = ctx.from.first_name || 'пользователь';
  
  try {
    // Проверяем подписку
    const subscription = await checkUserSubscription(chatId);
    
    // Получаем статистику по ключам
    const stats = await executeQuery(
      `SELECT COUNT(*) as total_keys, 
              MAX(created_at) as last_key_added
       FROM api_keys 
       WHERE chat_id = $1 AND api_key IS NOT NULL`,
      [chatId]
    );
    
    const totalKeys = stats.rows[0].total_keys || 0;
    const lastKeyAdded = stats.rows[0].last_key_added 
      ? new Date(stats.rows[0].last_key_added).toLocaleString('ru-RU')
      : 'ещё нет';
    
    // Формируем сообщение
    let statusMessage = `*📊 Ваша статистика, ${firstName}*\n\n`;
    statusMessage += `👤 *Telegram ID:* ${chatId}\n\n`;
    statusMessage += `📋 *Статус подписки:* ${subscription.status}\n`;
    
    if (subscription.expiresAt) {
      const expiresDate = subscription.expiresAt.toLocaleDateString('ru-RU');
      statusMessage += `📅 *Действует до:* ${expiresDate}\n`;
    }
    
    statusMessage += `\n🔑 *Ключей сохранено:* ${totalKeys}\n`;
    statusMessage += `⏰ *Последний добавлен:* ${lastKeyAdded}\n\n`;
    
    if (subscription.isValid) {
      statusMessage += `_Статус обработки: ✅ активен_`;
    } else {
      statusMessage += `_Статус обработки: ⚠️ ограничен (нельзя добавлять новые ключи)_`;
    }
    
    await ctx.reply(
      statusMessage,
      { 
        parse_mode: 'Markdown',
        ...mainMenu 
      }
    );
    
  } catch (error) {
    console.error('❌ Ошибка получения статуса:', error.message);
    await ctx.reply(
      `⚠️ *Временная ошибка, ${firstName}*\n\n` +
      'Не удалось получить статистику. Пожалуйста, попробуйте позже.',
      mainMenu
    );
  }
});

// ========== ОСТАЛЬНЫЕ КНОПКИ (без изменений) ==========
bot.hears('🆘 Помощь', async (ctx) => {
  await ctx.reply(
    `*❓ Частые вопросы:*\n\n` +
    `🔹 *Где взять API-ключ?*\n` +
    `В настройках вашего рекламного кабинета\n\n` +
    `🔹 *Ключ не принимается?*\n` +
    `1. Убедитесь что скопировали полностью (30+ символов)\n` +
    `2. Проверьте статус подписки\n\n` +
    `🔹 *Как проверить статус подписки?*\n` +
    `Нажмите кнопку "📊 Мой статус"\n\n` +
    `🔹 *Почему не принимает ключ?*\n` +
    `Если статус подписки не активен - обратитесь в поддержку.`,
    { 
      parse_mode: 'Markdown',
      ...mainMenu 
    }
  );
});

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
  const firstName = ctx.from.first_name || '';
  
  if (text.startsWith('/') || 
      ['🔑 Отправить API-ключ', '📊 Мой статус', '🆘 Помощь', '📞 Связаться с поддержкой'].includes(text)) {
    return;
  }
  
  if (text.length > 25 && /[a-zA-Z0-9._-]{25,}/.test(text)) {
    console.log(`🔑 Попытка сохранения ключа от ${chatId} (${firstName})`);
    
    const result = await saveApiKeyWithCheck(chatId, text, firstName);
    
    await ctx.reply(
      result.message,
      { 
        parse_mode: 'Markdown',
        ...mainMenu 
      }
    );
    
  } else {
    await ctx.reply(
      'Пожалуйста, используйте кнопки меню или отправьте API-ключ.',
      mainMenu
    );
  }
});

// ========== ЗАПУСК ==========
async function startBot() {
  try {
    await bot.telegram.deleteWebhook();
    console.log('✅ Очищены старые webhook');
    
    await bot.launch();
    console.log('✅ Бот запущен');
    
  } catch (error) {
    console.error('❌ Ошибка запуска бота:', error.message);
    setTimeout(startBot, 10000);
  }
}

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Сервер на порту ${PORT}`);
  console.log(`🤖 Версия: 4.0 (с проверкой подписок)`);
  console.log(`📊 API эндпоинты:`);
  console.log(`   POST /api/send-message`);
  console.log(`   POST /api/user/:chat_id/subscription`);
  console.log(`   GET  /api/user/:chat_id/status`);
  console.log(`   GET  /health`);
  
  setTimeout(startBot, 2000);
});

process.on('SIGTERM', () => {
  console.log('🛑 Завершение работы...');
  bot.stop();
  server.close();
  process.exit(0);
});

console.log('🚀 Система инициализирована');