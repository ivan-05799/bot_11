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

console.log('🤖 Инициализация бота...');
console.log('🔑 BOT_TOKEN есть:', !!BOT_TOKEN);
console.log('🗄️  DATABASE_URL есть:', !!DB_URL);

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
  ['⚡ Активировать подписку']
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
      console.log('✅ Подключение к БД успешно');
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
  } catch (error) {
    console.error('❌ Ошибка выполнения запроса:', error.message);
    throw error;
  } finally {
    if (db) {
      try {
        await db.end();
      } catch (error) {
        // Игнорируем
      }
    }
  }
}

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==========

async function saveApiKey(chatId, apiKeyText) {
  try {
    const duplicateCheck = await executeQuery(
      `SELECT created_at FROM api_keys WHERE chat_id = $1 AND api_key = $2`,
      [chatId, apiKeyText]
    );
    
    if (duplicateCheck.rows.length > 0) {
      const savedAt = new Date(duplicateCheck.rows[0].created_at).toLocaleString('ru-RU');
      return { success: false, reason: 'duplicate_key', savedAt: savedAt };
    }
    
    await executeQuery(
      `INSERT INTO api_keys (chat_id, api_key, platform, created_at, updated_at) 
       VALUES ($1, $2, $3, NOW(), NOW())`,
      [chatId, apiKeyText, 'api_key_saved']
    );
    
    console.log(`✅ Ключ сохранен: ${chatId}`);
    return { success: true };
    
  } catch (error) {
    console.error('❌ Ошибка сохранения ключа:', error.message);
    return { success: false, error: error.message };
  }
}

async function getUserStats(chatId) {
  try {
    const result = await executeQuery(
      `SELECT COUNT(*) as total_keys, MAX(created_at) as last_key_added
       FROM api_keys WHERE chat_id = $1 AND api_key IS NOT NULL`,
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
    return { totalKeys: 0, lastKeyAdded: 'ошибка' };
  }
}

function isAdmin(chatId) {
  const adminIds = [7909570066];
  return adminIds.includes(chatId);
}

// ========== API ЭНДПОИНТЫ ==========
app.post('/api/send-message', async (req, res) => {
  console.log('📨 Получен запрос на отправку сообщения');
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
  console.log('🏥 Health check');
  try {
    await executeQuery('SELECT 1 as status');
    res.json({ 
      status: 'ok', 
      bot: 'operational',
      database: 'connected',
      version: '8.1',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.json({ 
      status: 'degraded', 
      bot: 'operational',
      database: 'disconnected',
      version: '8.1',
      timestamp: new Date().toISOString()
    });
  }
});

// ========== ОБРАБОТЧИКИ КОМАНД ==========

// 1. Старт
bot.start(async (ctx) => {
  const chatId = ctx.chat.id;
  const firstName = ctx.from.first_name || '';
  
  console.log(`🚀 /start от ${chatId} (${firstName})`);
  
  const greeting = firstName ? `, ${firstName}!` : '!';
  const menuToShow = isAdmin(chatId) ? adminMenu : mainMenu;
  const adminNote = isAdmin(chatId) ? '\n\n👑 Вы администратор' : '';
  
  await ctx.reply(
    `🔐 Skayfol Analytics\n\n` +
    `Добро пожаловать${greeting}\n\n` +
    `✅ Тестовый режим активен` +
    `${adminNote}\n\n` +
    `Выберите действие:`,
    { ...menuToShow }
  );
});

// 2. Отправить API-ключ
bot.hears('🔑 Отправить API-ключ', async (ctx) => {
  console.log(`🔘 Нажата кнопка "Отправить API-ключ" от ${ctx.chat.id}`);
  await ctx.reply(
    'Отправьте API-ключ одной строкой (от 30 символов):\n\n' +
    '✅ ТЕСТОВЫЙ РЕЖИМ: Ключи принимаются без ограничений',
    { ...removeKeyboard }
  );
});

// 3. Мой статус
bot.hears('📊 Мой статус', async (ctx) => {
  const chatId = ctx.chat.id;
  const firstName = ctx.from.first_name || '';
  
  console.log(`🔘 Нажата кнопка "Мой статус" от ${chatId}`);
  
  try {
    const stats = await getUserStats(chatId);
    
    let msg = `📊 Ваша статистика${firstName ? ', ' + firstName : ''}\n\n`;
    msg += `👤 Telegram ID: ${chatId}\n`;
    msg += `🔑 Ключей сохранено: ${stats.totalKeys}\n`;
    msg += `⏰ Последний ключ: ${stats.lastKeyAdded}\n\n`;
    msg += `⚙️ Режим работы: Тестовый`;
    
    await ctx.reply(msg, { ...(isAdmin(chatId) ? adminMenu : mainMenu) });
  } catch (error) {
    await ctx.reply('⚠️ Ошибка получения статуса', mainMenu);
  }
});

// 4. Помощь
bot.hears('🆘 Помощь', async (ctx) => {
  console.log(`🔘 Нажата кнопка "Помощь" от ${ctx.chat.id}`);
  await ctx.reply(
    `❓ Помощь\n\n` +
    `🔹 Как отправить API-ключ?\n` +
    `Нажмите "🔑 Отправить API-ключ" и отправьте ключ\n\n` +
    `🔹 Как оформить подписку?\n` +
    `Нажмите "🎫 Оформить подписку на 30 дней"\n\n` +
    `🔹 Контакты поддержки:\n` +
    `📧 support@skayfol.com\n` +
    `🌐 https://skayfol.com`,
    { ...(isAdmin(ctx.chat.id) ? adminMenu : mainMenu) }
  );
});

// 5. Связаться с поддержкой
bot.hears('📞 Связаться с поддержкой', async (ctx) => {
  console.log(`🔘 Нажата кнопка "Связаться с поддержкой" от ${ctx.chat.id}`);
  await ctx.reply(
    `📞 Контакты поддержки\n\n` +
    `📧 Email: support@skayfol.com\n` +
    `🌐 Сайт: https://skayfol.com\n` +
    `⏰ Часы работы: 9:00-18:00 (МСК)\n\n` +
    `Ответ в течение 24 часов`,
    { ...(isAdmin(ctx.chat.id) ? adminMenu : mainMenu) }
  );
});

// 6. Оформить подписку на 30 дней
bot.hears('🎫 Оформить подписку на 30 дней', async (ctx) => {
  console.log(`🔘 Нажата кнопка "Оформить подписку" от ${ctx.chat.id}`);
  await ctx.reply(
    `🎫 Оформление подписки на 30 дней\n\n` +
    `Стоимость: 3000 руб.\n` +
    `Срок действия: 30 дней\n\n` +
    `Для оформления подписки:\n` +
    `1. Оплатите 3000 руб.\n` +
    `2. Отправьте скриншот оплаты в поддержку\n` +
    `3. Мы активируем подписку в течение 24 часов\n\n` +
    `📞 Контакты поддержки:\n` +
    `📧 Email: support@skayfol.com\n` +
    `🌐 Сайт: https://skayfol.com`,
    { ...(isAdmin(ctx.chat.id) ? adminMenu : mainMenu) }
  );
});

// 7. Активировать подписку (админ)
bot.hears('⚡ Активировать подписку', async (ctx) => {
  const chatId = ctx.chat.id;
  console.log(`🔘 Нажата кнопка "Активировать подписку" от ${chatId}`);
  
  if (!isAdmin(chatId)) {
    await ctx.reply('❌ Доступ только для администраторов', mainMenu);
    return;
  }
  
  await ctx.reply(
    'Введите Telegram ID для активации подписки на 30 дней:',
    { ...removeKeyboard }
  );
  ctx.session = { action: 'activate_subscription' };
});

// ========== ОБРАБОТКА ТЕКСТА ==========
bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  const chatId = ctx.chat.id;
  
  console.log(`📨 Текст от ${chatId}: "${text}"`);
  
  // Пропускаем команды
  if (text.startsWith('/')) return;
  
  // Обработка активации подписки
  if (ctx.session?.action === 'activate_subscription') {
    const targetChatId = parseInt(text);
    
    if (isNaN(targetChatId)) {
      await ctx.reply('❌ Некорректный ID', adminMenu);
      return;
    }
    
    await ctx.reply(`✅ Подписка для ${targetChatId} будет активирована`, adminMenu);
    delete ctx.session.action;
    return;
  }
  
  // Проверка API-ключа
  if (text.length > 25 && /[a-zA-Z0-9._-]{25,}/.test(text)) {
    console.log(`🔑 API-ключ от ${chatId}`);
    
    const result = await saveApiKey(chatId, text);
    
    if (result.success) {
      await ctx.reply(`✅ Ключ сохранен! Анализ данных начат.`, 
        { ...(isAdmin(chatId) ? adminMenu : mainMenu) });
    } else if (result.reason === 'duplicate_key') {
      await ctx.reply(`⚠️ Этот ключ уже сохранен (${result.savedAt})`, 
        { ...(isAdmin(chatId) ? adminMenu : mainMenu) });
    } else {
      await ctx.reply(`❌ Ошибка сохранения: ${result.error}`, 
        { ...(isAdmin(chatId) ? adminMenu : mainMenu) });
    }
    return;
  }
  
  // Для всего остального - показываем меню
  await ctx.reply(`Используйте кнопки меню.`, 
    { ...(isAdmin(chatId) ? adminMenu : mainMenu) });
});

// ========== ИНИЦИАЛИЗАЦИЯ СЕССИЙ ==========
bot.use((ctx, next) => {
  if (!ctx.session) ctx.session = {};
  return next();
});

// ========== ЗАПУСК ==========
async function startBot() {
  try {
    console.log('🔄 Запуск бота...');
    
    // Очищаем webhook
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    console.log('✅ Webhook очищен');
    
    // Получаем информацию о боте
    const botInfo = await bot.telegram.getMe();
    console.log(`🤖 Бот: @${botInfo.username} (${botInfo.first_name})`);
    
    // Запускаем
    await bot.launch();
    console.log('✅ Бот запущен в режиме polling');
    
    // Проверяем подключение к БД
    try {
      await executeQuery('SELECT 1 as status');
      console.log('✅ База данных подключена');
    } catch (error) {
      console.log('⚠️ База данных недоступна, но бот работает');
    }
    
  } catch (error) {
    console.error('❌ ОШИБКА ЗАПУСКА БОТА:', error.message);
    console.error('❌ Полная ошибка:', error);
    
    // Пробуем перезапустить через 10 секунд
    console.log('🔄 Перезапуск через 10 секунд...');
    setTimeout(startBot, 10000);
  }
}

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Сервер запущен на порту ${PORT}`);
  console.log(`🔗 URL: https://bot-11-2.onrender.com`);
  console.log(`📊 API: /api/send-message, /health`);
  
  // Запускаем бота через 3 секунды
  setTimeout(startBot, 3000);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Завершение работы...');
  bot.stop();
  server.close();
  process.exit(0);
});

console.log('🚀 Приложение инициализировано');