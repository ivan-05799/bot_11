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

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==========

/**
 * Проверяет активность подписки пользователя
 */
async function checkUserSubscription(telegramChatId) {
  let db;
  try {
    db = await getDbConnection();
    
    const result = await db.query(
      `SELECT subscription_status, subscription_expires_at 
       FROM api_keys 
       WHERE telegram_chat_id = $1 
       ORDER BY created_at DESC 
       LIMIT 1`,
      [telegramChatId]
    );
    
    if (result.rows.length === 0) {
      return { 
        hasSubscription: false, 
        status: null, 
        expiresAt: null,
        isValid: false 
      };
    }
    
    const row = result.rows[0];
    const status = row.subscription_status;
    const expiresAt = row.subscription_expires_at;
    
    // Проверяем активные статусы
    const isActive = status === 'active' || status === 'trial';
    
    // Проверяем срок действия
    let isExpired = false;
    if (expiresAt) {
      isExpired = new Date(expiresAt) < new Date();
    }
    
    const isValid = isActive && !isExpired;
    
    return {
      hasSubscription: true,
      status: status,
      expiresAt: expiresAt,
      isValid: isValid,
      isExpired: isExpired
    };
    
  } catch (error) {
    console.error('❌ Ошибка проверки подписки:', error);
    return { 
      hasSubscription: false, 
      status: null, 
      expiresAt: null,
      isValid: false,
      error: error.message 
    };
  } finally {
    if (db) await db.end();
  }
}

/**
 * Создает или обновляет запись пользователя при /start
 */
async function upsertUserOnStart(telegramChatId, firstName) {
  let db;
  try {
    db = await getDbConnection();
    
    // Проверяем существующую запись
    const existing = await db.query(
      `SELECT id, telegram_chat_id, api_key 
       FROM api_keys 
       WHERE telegram_chat_id = $1 
       ORDER BY created_at DESC 
       LIMIT 1`,
      [telegramChatId]
    );
    
    if (existing.rows.length > 0) {
      // Обновляем существующую запись (на случай смены chat_id)
      const record = existing.rows[0];
      console.log(`📝 Обновление записи пользователя ${telegramChatId} (${firstName})`);
      
      // Если у пользователя уже есть ключ, не трогаем его
      if (record.api_key) {
        return { 
          action: 'updated_existing', 
          hasKey: true,
          userId: record.id 
        };
      }
      
      return { 
        action: 'updated_existing', 
        hasKey: false,
        userId: record.id 
      };
    } else {
      // Создаем новую запись
      console.log(`👤 Создание новой записи для ${telegramChatId} (${firstName})`);
      
      const result = await db.query(
        `INSERT INTO api_keys 
         (telegram_chat_id, api_key, platform, subscription_status, created_at, updated_at) 
         VALUES ($1, $2, $3, $4, NOW(), NOW()) 
         RETURNING id`,
        [telegramChatId, null, 'telegram_bot', null]
      );
      
      return { 
        action: 'created_new', 
        hasKey: false,
        userId: result.rows[0].id 
      };
    }
    
  } catch (error) {
    console.error('❌ Ошибка создания/обновления пользователя:', error);
    throw error;
  } finally {
    if (db) await db.end();
  }
}

/**
 * Сохраняет API-ключ пользователя с проверкой подписки
 */
async function saveApiKeyWithSubscriptionCheck(telegramChatId, apiKeyText) {
  let db;
  try {
    // Сначала проверяем подписку
    const subscription = await checkUserSubscription(telegramChatId);
    
    if (!subscription.isValid) {
      // Пользователь не может сохранять ключи
      let message = '';
      
      if (subscription.status === 'expired' || subscription.isExpired) {
        message = `⚠️ *Ваша подписка истекла!*\n\n` +
                  `Для добавления новых API-ключей необходимо продлить подписку.\n\n` +
                  `📞 Свяжитесь с поддержкой для продления:\n` +
                  `📧 Email: support@skayfol.com\n` +
                  `🌐 Сайт: https://skayfol.com`;
      } else if (subscription.status === null) {
        message = `⏳ *Подписка не активирована*\n\n` +
                  `Перед добавлением API-ключей необходимо активировать подписку.\n\n` +
                  `📞 Обратитесь в поддержку:\n` +
                  `📧 Email: support@skayfol.com\n` +
                  `🌐 Сайт: https://skayfol.com`;
      } else {
        message = `❌ *Подписка не активна*\n\n` +
                  `Текущий статус: *${subscription.status || 'не определен'}*\n` +
                  `Для работы с API-ключами требуется активная подписка.\n\n` +
                  `📞 Свяжитесь с поддержкой:\n` +
                  `📧 Email: support@skayfol.com`;
      }
      
      return { 
        success: false, 
        reason: 'subscription_invalid',
        message: message,
        subscriptionStatus: subscription.status
      };
    }
    
    // Подписка активна - сохраняем ключ
    db = await getDbConnection();
    
    // Проверяем дубликат ключа для этого пользователя
    const duplicateCheck = await db.query(
      `SELECT id, created_at FROM api_keys 
       WHERE telegram_chat_id = $1 AND api_key = $2 
       AND api_key IS NOT NULL`,
      [telegramChatId, apiKeyText]
    );
    
    if (duplicateCheck.rows.length > 0) {
      const savedAt = new Date(duplicateCheck.rows[0].created_at).toLocaleString('ru-RU');
      return {
        success: false,
        reason: 'duplicate_key',
        savedAt: savedAt
      };
    }
    
    // Ищем запись пользователя для обновления
    const userRecord = await db.query(
      `SELECT id, api_key FROM api_keys 
       WHERE telegram_chat_id = $1 
       ORDER BY created_at DESC 
       LIMIT 1`,
      [telegramChatId]
    );
    
    if (userRecord.rows.length === 0) {
      // Создаем новую запись с ключом
      await db.query(
        `INSERT INTO api_keys 
         (telegram_chat_id, api_key, platform, created_at, updated_at) 
         VALUES ($1, $2, $3, NOW(), NOW())`,
        [telegramChatId, apiKeyText, 'unknown']
      );
    } else {
      const record = userRecord.rows[0];
      
      if (record.api_key) {
        // У пользователя уже есть ключ - создаем новую запись
        await db.query(
          `INSERT INTO api_keys 
           (telegram_chat_id, api_key, platform, created_at, updated_at) 
           VALUES ($1, $2, $3, NOW(), NOW())`,
          [telegramChatId, apiKeyText, 'unknown']
        );
      } else {
        // Обновляем существующую запись (без ключа)
        await db.query(
          `UPDATE api_keys 
           SET api_key = $1, platform = $2, updated_at = NOW() 
           WHERE id = $3`,
          [apiKeyText, 'unknown', record.id]
        );
      }
    }
    
    return { 
      success: true,
      reason: 'saved',
      subscriptionStatus: subscription.status
    };
    
  } catch (error) {
    console.error('❌ Ошибка сохранения ключа:', error);
    return {
      success: false,
      reason: 'database_error',
      error: error.message
    };
  } finally {
    if (db) await db.end();
  }
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

// Новый эндпоинт для проверки статуса подписки
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
      subscription_expires_at: subscription.expiresAt,
      is_valid: subscription.isValid,
      has_subscription: subscription.hasSubscription,
      is_expired: subscription.isExpired
    });
    
  } catch (error: any) {
    console.error('❌ [API] Ошибка проверки статуса:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    bot: 'operational',
    version: '3.0',
    features: ['subscription-check', 'keyboard', 'status-check', 'auto-recovery']
  });
});

// ========== КОМАНДА /start С СОЗДАНИЕМ ЗАПИСИ ==========
bot.start(async (ctx) => {
  const chatId = ctx.chat.id;
  const firstName = ctx.from.first_name;
  
  console.log(`🚀 /start от ${chatId} (${firstName})`);
  
  try {
    // Создаем/обновляем запись пользователя
    const userResult = await upsertUserOnStart(chatId, firstName);
    console.log(`✅ Пользователь ${chatId}: ${userResult.action}`);
    
    // Проверяем подписку для приветственного сообщения
    const subscription = await checkUserSubscription(chatId);
    
    let subscriptionInfo = '';
    if (subscription.hasSubscription) {
      if (subscription.isValid) {
        subscriptionInfo = `\n✅ *Статус подписки:* Активна`;
        if (subscription.expiresAt) {
          const expiresDate = new Date(subscription.expiresAt).toLocaleDateString('ru-RU');
          subscriptionInfo += ` (до ${expiresDate})`;
        }
      } else {
        subscriptionInfo = `\n⚠️ *Статус подписки:* ${subscription.status === 'expired' ? 'Истекла' : 'Не активна'}`;
      }
    } else {
      subscriptionInfo = `\n⏳ *Статус подписки:* Не активирована`;
    }
    
    await ctx.reply(
      `*🔐 Skayfol Analytics*\n\n` +
      `Добро пожаловать в систему аналитики рекламных кампаний, ${firstName}!\n\n` +
      `${subscriptionInfo}\n\n` +
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
    
  } catch (error) {
    console.error('❌ Ошибка при старте:', error);
    await ctx.reply(
      '⚠️ Произошла ошибка при регистрации. Пожалуйста, попробуйте позже.',
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
  let db;
  
  try {
    // Проверяем подписку
    const subscription = await checkUserSubscription(chatId);
    
    db = await getDbConnection();
    const result = await db.query(
      `SELECT COUNT(*) as total_keys, 
              MAX(created_at) as last_key_added,
              MAX(subscription_expires_at) as subscription_ends
       FROM api_keys 
       WHERE telegram_chat_id = $1 AND api_key IS NOT NULL`,
      [chatId]
    );
    
    const totalKeys = result.rows[0].total_keys || 0;
    const lastKeyAdded = result.rows[0].last_key_added 
      ? new Date(result.rows[0].last_key_added).toLocaleString('ru-RU')
      : 'ещё нет';
    
    let subscriptionText = '';
    if (subscription.hasSubscription) {
      subscriptionText = `\n📋 *Статус подписки:* ${subscription.status || 'не указан'}`;
      
      if (subscription.expiresAt) {
        const expiresDate = new Date(subscription.expiresAt).toLocaleDateString('ru-RU');
        subscriptionText += `\n📅 *Действует до:* ${expiresDate}`;
      }
      
      if (!subscription.isValid) {
        subscriptionText += `\n⚠️ *Требуется продление для добавления новых ключей*`;
      }
    } else {
      subscriptionText = `\n⏳ *Статус подписки:* Не активирована`;
    }
    
    await ctx.reply(
      `*📊 Ваша статистика*\n\n` +
      `👤 *Telegram ID:* ${chatId}\n` +
      `${subscriptionText}\n\n` +
      `🔑 *Ключей сохранено:* ${totalKeys}\n` +
      `⏰ *Последний добавлен:* ${lastKeyAdded}\n\n` +
      `_Статус обработки: ${subscription.isValid ? 'активен' : 'ограничен'}_`,
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
    `Убедитесь что скопировали полностью (30+ символов)\n` +
    `Также проверьте статус подписки\n\n` +
    `🔹 *Как долго обрабатывается?*\n` +
    `Обычно 5-15 минут\n\n` +
    `🔹 *Данные в безопасности?*\n` +
    `Да, ключи хранятся в зашифрованной базе\n\n` +
    `🔹 *Почему не принимает новый ключ?*\n` +
    `Проверьте статус подписки. При истёкшей подписке ` +
    `нельзя добавлять новые ключи. Обратитесь в поддержку.`,
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
    `_Ответим в течение 24 часов_\n\n` +
    `*Для чего обращаться:*\n` +
    `• Активация/продление подписки\n` +
    `• Проблемы с API-ключами\n` +
    `• Технические вопросы`,
    { 
      parse_mode: 'Markdown',
      ...mainMenu 
    }
  );
});

// ========== ОБРАБОТКА API-КЛЮЧЕЙ С ПРОВЕРКОЙ ПОДПИСКИ ==========
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
    
    const saveResult = await saveApiKeyWithSubscriptionCheck(chatId, text);
    
    if (saveResult.success) {
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
      
      console.log(`✅ Ключ от ${chatId} сохранён (статус: ${saveResult.subscriptionStatus})`);
      
    } else if (saveResult.reason === 'subscription_invalid') {
      // Подписка не активна - показываем сообщение о продлении
      await ctx.reply(
        saveResult.message,
        { 
          parse_mode: 'Markdown',
          ...mainMenu 
        }
      );
      
      console.log(`❌ Ключ от ${chatId} отклонён (статус подписки: ${saveResult.subscriptionStatus})`);
      
    } else if (saveResult.reason === 'duplicate_key') {
      const savedAt = saveResult.savedAt;
      await ctx.reply(
        `⚠️ *Этот ключ уже был сохранён!*\n\n` +
        `_Дата сохранения: ${savedAt}_\n\n` +
        `Если нужно обновить ключ - свяжитесь с поддержкой.`,
        { 
          parse_mode: 'Markdown',
          ...mainMenu 
        }
      );
      
    } else {
      // Другие ошибки
      await ctx.reply(
        '⚠️ *Ошибка сервера*\n\nПожалуйста, попробуйте позже или обратитесь в поддержку.',
        { 
          parse_mode: 'Markdown',
          ...mainMenu 
        }
      );
      
      console.error(`❌ Ошибка сохранения ключа от ${chatId}:`, saveResult.error);
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
    console.log('✅ Бот запущен с проверкой подписок');
    
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
  console.log(`🤖 Версия: 3.0 (проверка подписок)`);
  console.log(`📊 API эндпоинты:`);
  console.log(`   POST /api/send-message`);
  console.log(`   GET  /api/user/:chat_id/status`);
  console.log(`   GET  /health`);
  
  setTimeout(startBot, 1000);
});

server.on('error', (error: any) => {
  console.error('❌ Ошибка сервера:', error.message);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('🛑 Завершение работы...');
  if (botStarted) {
    bot.stop();
  }
  server.close();
  process.exit(0);
});

console.log('🚀 Система инициализирована');