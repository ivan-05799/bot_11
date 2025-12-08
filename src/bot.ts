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
      console.log(`✅ Подключение к БД успешно (попытка ${i + 1}/${retries})`);
      return db;
      
    } catch (error) {
      console.error(`❌ Ошибка подключения к БД (попытка ${i + 1}/${retries}):`, error.message);
      
      if (i < retries - 1) {
        console.log(`⏳ Повторная попытка через ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }
}

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==========

/**
 * Выполняет запрос к БД с автоматическим управлением подключением
 */
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
        console.error('Ошибка при закрытии соединения:', error.message);
      }
    }
  }
}

/**
 * Проверяет активность подписки пользователя
 * РЕЖИМ СОВМЕСТИМОСТИ: всегда возвращает true
 */
async function checkUserSubscription(telegramChatId) {
  try {
    // Пытаемся проверить структуру таблицы
    const structureCheck = await executeQuery(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'api_keys' 
      AND column_name IN ('subscription_status', 'telegram_chat_id', 'subscription_expires_at')
    `);
    
    const availableColumns = structureCheck.rows.map(row => row.column_name);
    const hasSubscriptionStatus = availableColumns.includes('subscription_status');
    const hasTelegramChatId = availableColumns.includes('telegram_chat_id');
    const hasSubscriptionExpiresAt = availableColumns.includes('subscription_expires_at');
    
    console.log('📊 Доступные колонки для подписки:', availableColumns);
    
    // Если есть все нужные колонки, проверяем подписку
    if (hasSubscriptionStatus && hasTelegramChatId) {
      const result = await executeQuery(
        `SELECT subscription_status, subscription_expires_at 
         FROM api_keys 
         WHERE telegram_chat_id = $1 
         ORDER BY created_at DESC 
         LIMIT 1`,
        [telegramChatId]
      );
      
      if (result.rows.length > 0) {
        const row = result.rows[0];
        const status = row.subscription_status;
        const expiresAt = row.subscription_expires_at;
        
        const isActive = status === 'active' || status === 'trial';
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
          isExpired: isExpired,
          subscriptionEnabled: true
        };
      }
    }
    
    // Режим совместимости: если колонок нет или запись не найдена, разрешаем все
    return { 
      hasSubscription: false, 
      status: null, 
      expiresAt: null,
      isValid: true, // Всегда true в режиме совместимости
      isExpired: false,
      subscriptionEnabled: false
    };
    
  } catch (error) {
    console.error('❌ Ошибка проверки подписки:', error.message);
    // В режиме совместимости при ошибке тоже разрешаем
    return { 
      hasSubscription: false, 
      status: null, 
      expiresAt: null,
      isValid: true, // Всегда true при ошибках
      isExpired: false,
      subscriptionEnabled: false,
      error: error.message 
    };
  }
}

/**
 * Создает или обновляет запись пользователя при /start
 */
async function upsertUserOnStart(telegramChatId, firstName) {
  try {
    // Пытаемся использовать telegram_chat_id если он есть
    const structureCheck = await executeQuery(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'api_keys' 
      AND column_name = 'telegram_chat_id'
    `);
    
    const hasTelegramChatId = structureCheck.rows.length > 0;
    
    if (hasTelegramChatId) {
      // Новая структура с telegram_chat_id
      const existing = await executeQuery(
        `SELECT id, telegram_chat_id, api_key 
         FROM api_keys 
         WHERE telegram_chat_id = $1 
         ORDER BY created_at DESC 
         LIMIT 1`,
        [telegramChatId]
      );
      
      if (existing.rows.length > 0) {
        console.log(`📝 Пользователь ${telegramChatId} уже существует в БД (новый формат)`);
        return { 
          action: 'existing', 
          hasKey: !!existing.rows[0].api_key,
          userId: existing.rows[0].id,
          format: 'new'
        };
      } else {
        // Создаем новую запись с telegram_chat_id
        console.log(`👤 Создание новой записи для ${telegramChatId} (новый формат)`);
        
        const result = await executeQuery(
          `INSERT INTO api_keys 
           (telegram_chat_id, api_key, platform, created_at, updated_at) 
           VALUES ($1, $2, $3, NOW(), NOW()) 
           RETURNING id`,
          [telegramChatId, null, 'telegram_bot']
        );
        
        return { 
          action: 'created', 
          hasKey: false,
          userId: result.rows[0].id,
          format: 'new'
        };
      }
    } else {
      // Старая структура - используем chat_id
      console.log(`👤 Используем старый формат (chat_id) для ${telegramChatId}`);
      
      const existing = await executeQuery(
        `SELECT id, chat_id, api_key 
         FROM api_keys 
         WHERE chat_id = $1 
         ORDER BY created_at DESC 
         LIMIT 1`,
        [telegramChatId]
      );
      
      if (existing.rows.length > 0) {
        return { 
          action: 'existing', 
          hasKey: !!existing.rows[0].api_key,
          userId: existing.rows[0].id,
          format: 'legacy'
        };
      } else {
        const result = await executeQuery(
          `INSERT INTO api_keys 
           (chat_id, api_key, platform, created_at, updated_at) 
           VALUES ($1, $2, $3, NOW(), NOW()) 
           RETURNING id`,
          [telegramChatId, null, 'telegram_bot']
        );
        
        return { 
          action: 'created', 
          hasKey: false,
          userId: result.rows[0].id,
          format: 'legacy'
        };
      }
    }
    
  } catch (error) {
    console.error('❌ Ошибка создания/обновления пользователя:', error.message);
    // В режиме совместимости не выбрасываем ошибку
    return { 
      action: 'error', 
      hasKey: false,
      userId: null,
      format: 'error',
      error: error.message 
    };
  }
}

/**
 * Сохраняет API-ключ пользователя (без проверки подписки в режиме совместимости)
 */
async function saveApiKey(telegramChatId, apiKeyText) {
  try {
    // Проверяем дубликат ключа
    const duplicateCheck = await executeQuery(
      `SELECT id, created_at FROM api_keys 
       WHERE chat_id = $1 AND api_key = $2 
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
    
    // Ищем существующую запись
    const userRecord = await executeQuery(
      `SELECT id, api_key FROM api_keys 
       WHERE chat_id = $1 
       ORDER BY created_at DESC 
       LIMIT 1`,
      [telegramChatId]
    );
    
    if (userRecord.rows.length === 0) {
      // Создаем новую запись с ключом
      await executeQuery(
        `INSERT INTO api_keys 
         (chat_id, api_key, platform, created_at, updated_at) 
         VALUES ($1, $2, $3, NOW(), NOW())`,
        [telegramChatId, apiKeyText, 'unknown']
      );
    } else {
      const record = userRecord.rows[0];
      
      if (record.api_key) {
        // У пользователя уже есть ключ - создаем новую запись
        await executeQuery(
          `INSERT INTO api_keys 
           (chat_id, api_key, platform, created_at, updated_at) 
           VALUES ($1, $2, $3, NOW(), NOW())`,
          [telegramChatId, apiKeyText, 'unknown']
        );
      } else {
        // Обновляем существующую запись (без ключа)
        await executeQuery(
          `UPDATE api_keys 
           SET api_key = $1, platform = $2, updated_at = NOW() 
           WHERE id = $3`,
          [apiKeyText, 'unknown', record.id]
        );
      }
    }
    
    return { 
      success: true,
      reason: 'saved'
    };
    
  } catch (error) {
    console.error('❌ Ошибка сохранения ключа:', error.message);
    return {
      success: false,
      reason: 'database_error',
      error: error.message
    };
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

// Эндпоинт для проверки статуса подписки
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
      is_expired: subscription.isExpired,
      subscription_enabled: subscription.subscriptionEnabled,
      mode: 'compatibility'
    });
    
  } catch (error: any) {
    console.error('❌ [API] Ошибка проверки статуса:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Эндпоинт для проверки структуры БД
app.get('/api/debug/db-structure', async (req, res) => {
  try {
    const result = await executeQuery(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns 
      WHERE table_name = 'api_keys' 
      ORDER BY ordinal_position
    `);
    
    res.json({
      table: 'api_keys',
      columns: result.rows,
      total: result.rows.length
    });
    
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/health', async (req, res) => {
  try {
    await executeQuery('SELECT 1 as status');
    
    res.json({ 
      status: 'ok', 
      bot: 'operational',
      database: 'connected',
      version: '3.3',
      mode: 'compatibility',
      features: ['keyboard', 'status-check', 'api-keys', 'legacy-support']
    });
    
  } catch (error) {
    console.error('❌ Health check failed:', error.message);
    res.json({ 
      status: 'degraded', 
      bot: 'operational',
      database: 'disconnected',
      version: '3.3',
      mode: 'compatibility'
    });
  }
});

// ========== КОМАНДА /start С СОЗДАНИЕМ ЗАПИСИ ==========
bot.start(async (ctx) => {
  const chatId = ctx.chat.id;
  const firstName = ctx.from.first_name;
  
  console.log(`🚀 /start от ${chatId} (${firstName})`);
  
  try {
    // Создаем/обновляем запись пользователя
    const userResult = await upsertUserOnStart(chatId, firstName);
    console.log(`✅ Пользователь ${chatId}: ${userResult.action} (формат: ${userResult.format})`);
    
    // Проверяем подписку (в режиме совместимости всегда true)
    const subscription = await checkUserSubscription(chatId);
    
    let subscriptionInfo = '';
    if (subscription.subscriptionEnabled && subscription.hasSubscription) {
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
      subscriptionInfo = `\n🔧 *Режим работы:* Совместимость (проверка подписок отключена)`;
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
    console.error('❌ Ошибка при старте:', error.message);
    // Даже при ошибке показываем приветствие
    await ctx.reply(
      `Привет, ${firstName}! Добро пожаловать в Skayfol Analytics!\n\n` +
      `Выберите действие:`,
      { 
        parse_mode: 'Markdown',
        ...mainMenu 
      }
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
  
  try {
    // Проверяем подписку (в режиме совместимости)
    const subscription = await checkUserSubscription(chatId);
    
    const result = await executeQuery(
      `SELECT COUNT(*) as total_keys, 
              MAX(created_at) as last_key_added
       FROM api_keys 
       WHERE chat_id = $1 AND api_key IS NOT NULL`,
      [chatId]
    );
    
    const totalKeys = result.rows[0].total_keys || 0;
    const lastKeyAdded = result.rows[0].last_key_added 
      ? new Date(result.rows[0].last_key_added).toLocaleString('ru-RU')
      : 'ещё нет';
    
    let subscriptionText = '';
    if (subscription.subscriptionEnabled && subscription.hasSubscription) {
      subscriptionText = `\n📋 *Статус подписки:* ${subscription.status || 'не указан'}`;
      
      if (subscription.expiresAt) {
        const expiresDate = new Date(subscription.expiresAt).toLocaleDateString('ru-RU');
        subscriptionText += `\n📅 *Действует до:* ${expiresDate}`;
      }
      
      if (!subscription.isValid) {
        subscriptionText += `\n⚠️ *Требуется продление для добавления новых ключей*`;
      }
    } else {
      subscriptionText = `\n🔧 *Режим:* Совместимость (все операции разрешены)`;
    }
    
    await ctx.reply(
      `*📊 Ваша статистика*\n\n` +
      `👤 *Telegram ID:* ${chatId}\n` +
      `${subscriptionText}\n\n` +
      `🔑 *Ключей сохранено:* ${totalKeys}\n` +
      `⏰ *Последний добавлен:* ${lastKeyAdded}\n\n` +
      `_Статус обработки: активен_`,
      { 
        parse_mode: 'Markdown',
        ...mainMenu 
      }
    );
    
  } catch (error) {
    console.error('❌ Ошибка получения статуса:', error.message);
    await ctx.reply(
      '⚠️ *Временная ошибка сервера*\n\n' +
      'Не удалось получить статистику. Пожалуйста, попробуйте позже.',
      mainMenu
    );
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
    `Да, ключи хранятся в зашифрованной базе\n\n` +
    `🔹 *Проверка подписок?*\n` +
    `В данный момент функция проверки подписок временно отключена`,
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

// ========== ОБРАБОТКА API-КЛЮЧЕЙ (БЕЗ ПРОВЕРКИ ПОДПИСКИ) ==========
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
    
    const saveResult = await saveApiKey(chatId, text);
    
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
      
      console.log(`✅ Ключ от ${chatId} сохранён`);
      
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
async function startBot() {
  try {
    // Очищаем старые webhook
    await bot.telegram.deleteWebhook();
    console.log('✅ Очищены старые webhook');
    
    await bot.launch();
    console.log('✅ Бот запущен в режиме совместимости');
    
    // Тестируем подключение к БД
    try {
      await executeQuery('SELECT NOW() as time');
      console.log('✅ Подключение к БД успешно');
      
      // Проверяем структуру таблицы
      const structure = await executeQuery(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'api_keys'
      `);
      console.log(`📊 Таблица api_keys имеет ${structure.rows.length} колонок`);
      
    } catch (dbError) {
      console.log('⚠️ БД недоступна, бот работает в ограниченном режиме');
    }
    
  } catch (error: any) {
    if (error.message.includes('409')) {
      console.log('⚠️ Конфликт 409 - вебхук уже установлен');
    } else {
      console.error('❌ Ошибка запуска бота:', error.message);
      setTimeout(startBot, 10000);
    }
  }
}

// ========== ЗАПУСК СЕРВЕРА ==========
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Сервер на порту ${PORT}`);
  console.log(`🤖 Версия: 3.3 (режим совместимости)`);
  console.log(`📊 API эндпоинты:`);
  console.log(`   POST /api/send-message`);
  console.log(`   GET  /api/user/:chat_id/status`);
  console.log(`   GET  /api/debug/db-structure`);
  console.log(`   GET  /health`);
  
  // Даем время на инициализацию
  setTimeout(startBot, 2000);
});

server.on('error', (error: any) => {
  console.error('❌ Ошибка сервера:', error.message);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Завершение работы...');
  bot.stop();
  server.close();
  process.exit(0);
});

console.log('🚀 Система инициализирована в режиме совместимости');