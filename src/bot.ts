import { Telegraf, Markup } from 'telegraf';
import { Client } from 'pg';
import dotenv from 'dotenv';
import express from 'express';
import cron from 'node-cron';

dotenv.config();

// ========== КОНФИГУРАЦИЯ ==========
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CUSTOMER_DB_URL = process.env.CUSTOMER_DB_URL || ''; // БД заказчика для api_keys
const OUR_DB_URL = process.env.OUR_DB_URL || ''; // Наша БД для управления доступом
const ADMIN_CHAT_IDS = (process.env.ADMIN_CHAT_IDS || '7909570066,7739218540')
  .split(',')
  .map(id => id.trim());
const PORT = parseInt(process.env.PORT || '10000');

// Проверка обязательных переменных
if (!BOT_TOKEN || !CUSTOMER_DB_URL || !OUR_DB_URL) {
  console.error('❌ Не хватает обязательных переменных окружения');
  console.error('BOT_TOKEN:', !!BOT_TOKEN);
  console.error('CUSTOMER_DB_URL:', !!CUSTOMER_DB_URL);
  console.error('OUR_DB_URL:', !!OUR_DB_URL);
  process.exit(1);
}

console.log(`👑 Администраторы: ${ADMIN_CHAT_IDS.join(', ')}`);

const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());

// ========== КЛАВИАТУРЫ ==========
const mainMenu = Markup.keyboard([
  ['🔑 Отправить API-ключ'],
  ['📊 Мой статус'],
  ['📞 Связаться с поддержкой'],
  ['🏠 Главное меню']
]).resize();

const platformMenu = Markup.keyboard([
  ['1. Meta', '2. Tik Tok'],
  ['3. Google', '4. Others'],
  ['↩️ Назад']
]).resize();

const supportButton = Markup.inlineKeyboard([
  Markup.button.url('📞 Написать в поддержку', 'https://t.me/Seo_skayfol_analytics')
]);

const adminMenu = Markup.keyboard([
  ['👤 Добавить пользователя'],
  ['📋 Список пользователей'],
  ['📊 Статистика доступа'],
  ['🔙 Выход из админки']
]).resize();

const removeKeyboard = Markup.removeKeyboard();

// ========== ПОДКЛЮЧЕНИЯ К БД ==========
async function getOurDbConnection() {
  const db = new Client({ 
    connectionString: OUR_DB_URL,
    connectionTimeoutMillis: 10000,
    ssl: { rejectUnauthorized: false }
  });
  await db.connect();
  return db;
}

async function getCustomerDbConnection() {
  const db = new Client({ 
    connectionString: CUSTOMER_DB_URL,
    connectionTimeoutMillis: 10000,
    ssl: { rejectUnauthorized: false }
  });
  await db.connect();
  return db;
}

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==========
function isAdmin(chatId: number | string): boolean {
  return ADMIN_CHAT_IDS.includes(chatId.toString());
}

function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

async function checkUserAccess(chatId: number): Promise<{hasAccess: boolean, daysLeft: number, expiresAt: Date | null, isActive: boolean}> {
  // АДМИНЫ ВСЕГДА ИМЕЮТ ДОСТУП
  if (isAdmin(chatId)) {
    return { 
      hasAccess: true, 
      daysLeft: 999, 
      expiresAt: null, 
      isActive: true 
    };
  }
  
  let db;
  try {
    db = await getOurDbConnection();
    const result = await db.query(
      `SELECT expires_at, is_active 
       FROM user_access 
       WHERE chat_id = $1 
       AND is_active = true 
       AND expires_at > NOW()`,
      [chatId]
    );
    
    if (result.rows.length === 0) {
      return { hasAccess: false, daysLeft: 0, expiresAt: null, isActive: false };
    }
    
    const expiresAt = new Date(result.rows[0].expires_at);
    const now = new Date();
    const timeDiff = expiresAt.getTime() - now.getTime();
    const daysLeft = Math.max(0, Math.ceil(timeDiff / (1000 * 3600 * 24)));
    
    return { 
      hasAccess: true, 
      daysLeft, 
      expiresAt, 
      isActive: result.rows[0].is_active 
    };
    
  } catch (error) {
    console.error('❌ Ошибка проверки доступа:', error);
    return { hasAccess: false, daysLeft: 0, expiresAt: null, isActive: false };
  } finally {
    if (db) await db.end();
  }
}

async function logAdminAction(adminId: number, action: string, targetUserId?: number, details?: any) {
  let db;
  try {
    db = await getOurDbConnection();
    await db.query(
      `INSERT INTO admin_logs (admin_id, action, target_user_id, details) 
       VALUES ($1, $2, $3, $4)`,
      [adminId, action, targetUserId || null, details ? JSON.stringify(details) : null]
    );
  } catch (error) {
    console.error('❌ Ошибка логирования:', error);
  } finally {
    if (db) await db.end();
  }
}

async function updateUserCache(chatId: number, userData: any) {
  let db;
  try {
    db = await getOurDbConnection();
    await db.query(
      `INSERT INTO user_cache (chat_id, username, first_name, last_name, language_code, last_seen)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (chat_id) 
       DO UPDATE SET 
         username = EXCLUDED.username,
         first_name = EXCLUDED.first_name,
         last_name = EXCLUDED.last_name,
         language_code = EXCLUDED.language_code,
         last_seen = NOW()`,
      [
        chatId,
        userData.username,
        userData.first_name,
        userData.last_name,
        userData.language_code
      ]
    );
  } catch (error) {
    console.error('❌ Ошибка обновления кэша:', error);
  } finally {
    if (db) await db.end();
  }
}

// ========== ПРОВЕРКА УВЕДОМЛЕНИЙ ОБ ИСТЕЧЕНИИ ==========
async function checkExpiringSubscriptions() {
  console.log('🕐 Проверка подписок на истечение...');
  let db;
  try {
    db = await getOurDbConnection();
    
    // Проверяем подписки, которые истекают через 3 дня
    const threeDaysResult = await db.query(
      `SELECT ua.chat_id, ua.expires_at 
       FROM user_access ua
       WHERE ua.is_active = true 
       AND ua.expires_at BETWEEN NOW() + INTERVAL '3 days' AND NOW() + INTERVAL '3 days 1 hour'
       AND NOT EXISTS (
         SELECT 1 FROM notifications 
         WHERE user_id = ua.chat_id 
         AND notification_type = 'expire_3days'
       )`,
      []
    );
    
    for (const row of threeDaysResult.rows) {
      try {
        await bot.telegram.sendMessage(
          row.chat_id,
          `⚠️ *Внимание\\!*\n\nВаша подписка истекает через 3 дня\\.\nДля продления обратитесь к администратору\\.`,
          { parse_mode: 'MarkdownV2' }
        );
        
        await db.query(
          `INSERT INTO notifications (user_id, notification_type) VALUES ($1, 'expire_3days')`,
          [row.chat_id]
        );
        
        console.log(`📢 Отправлено уведомление \\(3 дня\\) пользователю ${row.chat_id}`);
      } catch (error: any) {
        console.error(`❌ Ошибка отправки уведомления пользователю ${row.chat_id}:`, error.message);
      }
    }
    
    // Проверяем подписки, которые истекают через 1 день
    const oneDayResult = await db.query(
      `SELECT ua.chat_id, ua.expires_at 
       FROM user_access ua
       WHERE ua.is_active = true 
       AND ua.expires_at BETWEEN NOW() + INTERVAL '1 day' AND NOW() + INTERVAL '1 day 1 hour'
       AND NOT EXISTS (
         SELECT 1 FROM notifications 
         WHERE user_id = ua.chat_id 
         AND notification_type = 'expire_1day'
       )`,
      []
    );
    
    for (const row of oneDayResult.rows) {
      try {
        await bot.telegram.sendMessage(
          row.chat_id,
          `🚨 *Срочное уведомление\\!*\n\nВаша подписка истекает ЗАВТРА\\!\nСрочно обратитесь к администратору для продления\\.`,
          { parse_mode: 'MarkdownV2' }
        );
        
        await db.query(
          `INSERT INTO notifications (user_id, notification_type) VALUES ($1, 'expire_1day')`,
          [row.chat_id]
        );
        
        console.log(`📢 Отправлено уведомление \\(1 день\\) пользователю ${row.chat_id}`);
      } catch (error: any) {
        console.error(`❌ Ошибка отправки уведомления пользователю ${row.chat_id}:`, error.message);
      }
    }
    
    console.log(`✅ Проверка завершена\\. Найдено: ${threeDaysResult.rows.length + oneDayResult.rows.length} подписок`);
    
  } catch (error) {
    console.error('❌ Ошибка проверки подписок:', error);
  } finally {
    if (db) await db.end();
  }
}

// ========== WEBHOOK ДЛЯ ЗАКАЗЧИКА ==========
app.post('/api/send-message', async (req, res) => {
  try {
    const { chat_id, message } = req.body;
    
    if (!chat_id || !message) {
      return res.status(400).json({ error: 'Нужны chat_id и message' });
    }

    await bot.telegram.sendMessage(chat_id, message, { 
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
    version: '3.1',
    features: ['dual-database', 'admin-panel', 'subscription-system', 'multi-admin'],
    admin_count: ADMIN_CHAT_IDS.length
  });
});

// ========== ХРАНЕНИЕ ВРЕМЕННЫХ ДАННЫХ ==========
const userStates = new Map();
const adminStates = new Map();

// ========== КОМАНДА /start ==========
bot.start(async (ctx) => {
  const chatId = ctx.chat.id;
  const user = ctx.from;
  
  console.log(`🚀 /start от ${chatId} (${user.first_name} @${user.username})`);
  
  // Обновляем кэш пользователя
  await updateUserCache(chatId, user);
  
  // Если пользователь - админ, показываем админку
  if (isAdmin(chatId)) {
    const adminName = user.username ? `@${user.username}` : user.first_name;
    const escapedName = escapeMarkdown(adminName);
    
    await ctx.reply(
      `👑 *Панель администратора*\n\n` +
      `Добро пожаловать, администратор ${escapedName}\\!\n` +
      `Выберите действие:`,
      { 
        parse_mode: 'MarkdownV2',
        ...adminMenu 
      }
    );
    return;
  }
  
  // Проверяем доступ для обычных пользователей
  const { hasAccess, daysLeft } = await checkUserAccess(chatId);
  
  if (!hasAccess) {
    await ctx.reply(
      `❌ *Доступ запрещен*\n\n` +
      `У вас нет активной подписки\\.\n` +
      `Для получения доступа обратитесь к администратору\\.\n\n` +
      `Ваш ID для предоставления доступа: \`${chatId}\`\n\n` +
      `📞 Контакт: @Seo\\_skayfol\\_analytics`,
      { 
        parse_mode: 'MarkdownV2',
        ...removeKeyboard 
      }
    );
    return;
  }
  
  // Пользователь с доступом
  await showMainMenu(ctx);
});

// ========== КОМАНДА /myid ==========
bot.command('myid', async (ctx) => {
  await ctx.reply(`Ваш chat\\_id: \`${ctx.chat.id}\``, { 
    parse_mode: 'MarkdownV2',
    ...removeKeyboard 
  });
});

// ========== КОМАНДА /admin ==========
bot.command('admin', async (ctx) => {
  const chatId = ctx.chat.id;
  
  if (!isAdmin(chatId)) {
    await ctx.reply('❌ У вас нет прав администратора\\.', { parse_mode: 'MarkdownV2', ...mainMenu });
    return;
  }
  
  adminStates.delete(chatId);
  const user = ctx.from;
  const adminName = user.username ? `@${user.username}` : user.first_name;
  const escapedName = escapeMarkdown(adminName);
  
  await ctx.reply(
    `👑 *Панель администратора*\n\n` +
    `Приветствую, ${escapedName}\\!\n` +
    `Выберите действие:`,
    { 
      parse_mode: 'MarkdownV2',
      ...adminMenu 
    }
  );
});

// ========== АДМИН ПАНЕЛЬ ==========
bot.hears('🔙 Выход из админки', async (ctx) => {
  const chatId = ctx.chat.id;
  if (!isAdmin(chatId)) return;
  
  adminStates.delete(chatId);
  await showMainMenu(ctx);
});

bot.hears('👤 Добавить пользователя', async (ctx) => {
  const chatId = ctx.chat.id;
  if (!isAdmin(chatId)) return;
  
  adminStates.set(chatId, { action: 'add_user', step: 'waiting_id' });
  
  await ctx.reply(
    `*Добавление пользователя*\n\n` +
    `Отправьте chat\\_id пользователя, которому нужно предоставить доступ\\.\n\n` +
    `*Формат:* Только цифры \\(например: 1234567890\\)\n` +
    `*Доступ предоставляется на 30 дней*`,
    { 
      parse_mode: 'MarkdownV2',
      ...removeKeyboard 
    }
  );
});

bot.hears('📋 Список пользователей', async (ctx) => {
  const chatId = ctx.chat.id;
  if (!isAdmin(chatId)) return;
  
  let db;
  try {
    db = await getOurDbConnection();
    const result = await db.query(
      `SELECT 
        ua.chat_id,
        ua.granted_at,
        ua.expires_at,
        ua.is_active,
        ua.notes,
        uc.username,
        uc.first_name,
        COUNT(ak.id) as key_count
       FROM user_access ua
       LEFT JOIN user_cache uc ON ua.chat_id = uc.chat_id
       LEFT JOIN (
         SELECT chat_id, COUNT(*) as id 
         FROM api_keys 
         GROUP BY chat_id
       ) ak ON ua.chat_id = ak.chat_id
       GROUP BY ua.id, uc.username, uc.first_name
       ORDER BY ua.expires_at DESC
       LIMIT 50`,
      []
    );
    
    let message = `*📋 Список пользователей \\(последние 50\\)*\n\n`;
    
    if (result.rows.length === 0) {
      message += `Нет пользователей с доступом\\.`;
    } else {
      result.rows.forEach((row, index) => {
        const grantedDate = new Date(row.granted_at).toLocaleDateString('ru-RU');
        const expiresDate = new Date(row.expires_at).toLocaleDateString('ru-RU');
        const now = new Date();
        const expiresAt = new Date(row.expires_at);
        const daysLeft = Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / (1000 * 3600 * 24)));
        
        const userName = escapeMarkdown(row.first_name || row.username || 'Неизвестно');
        const notes = row.notes ? escapeMarkdown(row.notes) : '';
        
        message += `${index + 1}\\. ${userName} \\(ID: ${row.chat_id}\\)\n`;
        message += `   📅 Выдан: ${grantedDate}\n`;
        message += `   ⏳ Истекает: ${expiresDate} \\(${daysLeft} дн\\.\\)\n`;
        message += `   🔑 Ключей: ${row.key_count || 0}\n`;
        message += `   ${row.is_active ? '✅ Активен' : '❌ Неактивен'}\n`;
        if (row.notes) {
          message += `   📝 Заметки: ${notes}\n`;
        }
        message += `\n`;
      });
    }
    
    // Разбиваем сообщение если слишком длинное
    if (message.length > 4000) {
      const parts = message.match(/[\s\S]{1,4000}/g) || [];
      for (let i = 0; i < parts.length; i++) {
        await ctx.reply(parts[i], { 
          parse_mode: 'MarkdownV2',
          ...(i === parts.length - 1 ? adminMenu : {})
        });
      }
    } else {
      await ctx.reply(message, { 
        parse_mode: 'MarkdownV2',
        ...adminMenu 
      });
    }
    
  } catch (error) {
    console.error('❌ Ошибка получения списка:', error);
    await ctx.reply('⚠️ Ошибка получения данных', adminMenu);
  } finally {
    if (db) await db.end();
  }
});

bot.hears('📊 Статистика доступа', async (ctx) => {
  const chatId = ctx.chat.id;
  if (!isAdmin(chatId)) return;
  
  let db;
  try {
    db = await getOurDbConnection();
    
    const totalUsers = await db.query('SELECT COUNT(*) FROM user_access', []);
    const activeUsers = await db.query(
      'SELECT COUNT(*) FROM user_access WHERE is_active = true AND expires_at > NOW()', 
      []
    );
    const expiredUsers = await db.query(
      'SELECT COUNT(*) FROM user_access WHERE expires_at <= NOW()', 
      []
    );
    const inactiveUsers = await db.query(
      'SELECT COUNT(*) FROM user_access WHERE is_active = false', 
      []
    );
    
    const expiringSoon = await db.query(
      `SELECT COUNT(*) FROM user_access 
       WHERE is_active = true 
       AND expires_at BETWEEN NOW() AND NOW() + INTERVAL '7 days'`,
      []
    );
    
    // Получаем статистику по ключам из БД заказчика
    let customerDb;
    let platformStats = 'Не удалось получить';
    try {
      customerDb = await getCustomerDbConnection();
      const platformResult = await customerDb.query(
        `SELECT platform, COUNT(*) as count 
         FROM api_keys 
         GROUP BY platform 
         ORDER BY count DESC`,
        []
      );
      
      if (platformResult.rows.length > 0) {
        platformStats = platformResult.rows.map(row => 
          `${row.platform}: ${row.count}`
        ).join('\n');
      }
    } catch (error) {
      console.error('❌ Ошибка получения статистики ключей:', error);
    } finally {
      if (customerDb) await customerDb.end();
    }
    
    const message = 
      `*📊 Статистика системы*\n\n` +
      `*👥 Пользователи:*\n` +
      `• Всего пользователей: ${totalUsers.rows[0].count}\n` +
      `• Активных подписок: ${activeUsers.rows[0].count}\n` +
      `• Истекают через 7 дней: ${expiringSoon.rows[0].count}\n` +
      `• Истекших подписок: ${expiredUsers.rows[0].count}\n` +
      `• Деактивированных: ${inactiveUsers.rows[0].count}\n\n` +
      `*🔑 Ключи по платформам:*\n${platformStats}\n\n` +
      `*👑 Администраторы:* ${ADMIN_CHAT_IDS.length}\n` +
      `_Данные обновлены: ${new Date().toLocaleString('ru-RU')}_`;
    
    await ctx.reply(message, { 
      parse_mode: 'MarkdownV2',
      ...adminMenu 
    });
    
  } catch (error) {
    console.error('❌ Ошибка статистики:', error);
    await ctx.reply('⚠️ Ошибка получения статистики', adminMenu);
  } finally {
    if (db) await db.end();
  }
});

// ========== ОБРАБОТКА ВВОДА АДМИНА ==========
bot.on('text', async (ctx) => {
  const text = ctx.message.text;
  const chatId = ctx.chat.id;
  const user = ctx.from;
  
  // Обработка админских действий
  if (isAdmin(chatId)) {
    const adminState = adminStates.get(chatId);
    
    if (adminState?.action === 'add_user' && adminState.step === 'waiting_id') {
      // Валидация chat_id
      if (!/^\d{8,12}$/.test(text)) {
        await ctx.reply(
          '❌ Неверный формат chat\\_id\\!\n\n' +
          'chat\\_id должен содержать только цифры \\(8\\-12 символов\\)\\.\n' +
          'Пример: 7909570066\n\n' +
          'Попробуйте еще раз:',
          { parse_mode: 'MarkdownV2' }
        );
        return;
      }
      
      const userId = parseInt(text);
      
      // Проверяем, не является ли пользователь самим собой
      if (userId === chatId) {
        await ctx.reply('❌ Нельзя добавить самого себя\\!', { parse_mode: 'MarkdownV2', ...adminMenu });
        adminStates.delete(chatId);
        return;
      }
      
      // Проверяем, не является ли пользователь другим админом
      if (ADMIN_CHAT_IDS.includes(userId.toString())) {
        await ctx.reply('❌ Этот пользователь уже является администратором\\!', { parse_mode: 'MarkdownV2', ...adminMenu });
        adminStates.delete(chatId);
        return;
      }
      
      // Проверяем, не существует ли уже доступ
      let db;
      try {
        db = await getOurDbConnection();
        
        const existingAccess = await db.query(
          `SELECT * FROM user_access WHERE chat_id = $1`,
          [userId]
        );
        
        if (existingAccess.rows.length > 0) {
          const row = existingAccess.rows[0];
          const expiresAt = new Date(row.expires_at);
          const formattedDate = expiresAt.toLocaleDateString('ru-RU');
          const now = new Date();
          const isActive = row.is_active && expiresAt > now;
          
          await ctx.reply(
            `*ℹ️ Пользователь ${userId} уже есть в системе\\!*\n\n` +
            `Статус: ${isActive ? '✅ Активен' : '❌ Неактивен'}\n` +
            `Истекает: ${formattedDate}\n` +
            `Заметки: ${row.notes || 'нет'}\n\n` +
            `Выберите действие:\n` +
            `1\\. *Продлить на 30 дней* \\(отправьте "1"\\)\n` +
            `2\\. *Деактивировать* \\(отправьте "2"\\)\n` +
            `3\\. *Отмена* \\(отправьте "3"\\)`,
            { parse_mode: 'MarkdownV2' }
          );
          
          adminState.step = 'confirm_action';
          adminState.userId = userId;
          adminState.existingData = row;
          adminStates.set(chatId, adminState);
          return;
        }
        
        // Добавляем новый доступ через процедуру
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 30);
        
        const adminName = user.username ? `@${user.username}` : user.first_name;
        const escapedName = escapeMarkdown(adminName);
        
        await db.query(
          `CALL add_user_access($1, $2, $3, $4)`,
          [userId, chatId, 30, `Добавлен админом ${adminName}`]
        );
        
        // Логируем действие
        await logAdminAction(chatId, 'add_user', userId, { 
          admin: adminName,
          days: 30,
          expires_at: expiresAt.toISOString()
        });
        
        // Пробуем уведомить пользователя
        try {
          await bot.telegram.sendMessage(
            userId,
            `*🎉 Вам предоставлен доступ\\!*\n\n` +
            `Администратор ${escapedName} предоставил вам доступ к Skayfol Analytics\\.\n\n` +
            `✅ Доступ активен с сегодняшнего дня\n` +
            `📅 Срок действия: 30 дней\n` +
            `⏳ Истекает: ${expiresAt.toLocaleDateString('ru-RU')}\n\n` +
            `Используйте /start для начала работы\\!`,
            { parse_mode: 'MarkdownV2' }
          );
        } catch (error: any) {
          console.log(`ℹ️ Не удалось уведомить пользователя ${userId}: ${error.message}`);
          // Это нормально, если пользователь еще не писал боту
        }
        
        await ctx.reply(
          `*✅ Пользователь ${userId} успешно добавлен\\!*\n\n` +
          `Доступ предоставлен на 30 дней\\.\n` +
          `Истекает: ${expiresAt.toLocaleDateString('ru-RU')}\n\n` +
          `${
            ADMIN_CHAT_IDS.includes(userId.toString()) 
            ? '_Пользователь получил уведомление_' 
            : '_Пользователь получит уведомление при первом запуске бота_'
          }`,
          { 
            parse_mode: 'MarkdownV2',
            ...adminMenu 
          }
        );
        
        console.log(`👤 Админ ${chatId} \\(${adminName}\\) добавил пользователя ${userId}`);
        
      } catch (error) {
        console.error('❌ Ошибка добавления пользователя:', error);
        await ctx.reply('⚠️ Ошибка добавления пользователя', adminMenu);
      } finally {
        adminStates.delete(chatId);
        if (db) await db.end();
      }
      return;
    }
    
    // Обработка подтверждения действий для существующего пользователя
    if (adminState?.action === 'add_user' && adminState.step === 'confirm_action' && adminState.userId) {
      let db;
      try {
        db = await getOurDbConnection();
        const adminName = user.username ? `@${user.username}` : user.first_name;
        const escapedName = escapeMarkdown(adminName);
        
        if (text === '1') {
          // Продлить на 30 дней
          const expiresAt = new Date();
          expiresAt.setDate(expiresAt.getDate() + 30);
          
          await db.query(
            `UPDATE user_access 
             SET expires_at = $1, 
                 is_active = true,
                 updated_at = NOW(),
                 notes = COALESCE(notes || ', ', '') || 'Продлен админом ${adminName}'
             WHERE chat_id = $2`,
            [expiresAt, adminState.userId]
          );
          
          await logAdminAction(chatId, 'extend_access', adminState.userId, { 
            admin: adminName, 
            days: 30,
            expires_at: expiresAt.toISOString()
          });
          
          // Уведомляем пользователя
          try {
            await bot.telegram.sendMessage(
              adminState.userId,
              `*🔄 Ваш доступ продлен\\!*\n\n` +
              `Администратор ${escapedName} продлил ваш доступ к Skayfol Analytics\\.\n\n` +
              `✅ Доступ продлен\n` +
              `📅 Новый срок: ${expiresAt.toLocaleDateString('ru-RU')}\n` +
              `⏳ Осталось: 30 дней\n\n` +
              `Продолжайте пользоваться сервисом\\!`,
              { parse_mode: 'MarkdownV2' }
            );
          } catch (error) {
            console.log(`ℹ️ Не удалось уведомить пользователя ${adminState.userId} о продлении`);
          }
          
          await ctx.reply(
            `*✅ Доступ пользователя ${adminState.userId} продлен на 30 дней\\!*\n` +
            `Новая дата истечения: ${expiresAt.toLocaleDateString('ru-RU')}`,
            { parse_mode: 'MarkdownV2', ...adminMenu }
          );
          
        } else if (text === '2') {
          // Деактивировать
          await db.query(
            `UPDATE user_access SET is_active = false, updated_at = NOW() WHERE chat_id = $1`,
            [adminState.userId]
          );
          
          await logAdminAction(chatId, 'deactivate_access', adminState.userId, { admin: adminName });
          
          await ctx.reply(
            `*✅ Пользователь ${adminState.userId} деактивирован\\.*`,
            { parse_mode: 'MarkdownV2', ...adminMenu }
          );
          
        } else if (text === '3') {
          // Отмена
          await ctx.reply('*❌ Действие отменено\\.*', { parse_mode: 'MarkdownV2', ...adminMenu });
        } else {
          await ctx.reply('*❌ Неверный выбор\\. Используйте 1, 2 или 3\\.*', { parse_mode: 'MarkdownV2', ...adminMenu });
          return;
        }
        
      } catch (error) {
        console.error('❌ Ошибка обработки действия:', error);
        await ctx.reply('⚠️ Ошибка обработки', adminMenu);
      } finally {
        adminStates.delete(chatId);
        if (db) await db.end();
      }
      return;
    }
  }
  
  // ========== ПРОВЕРКА ДОСТУПА ДЛЯ ОБЫЧНЫХ ПОЛЬЗОВАТЕЛЕЙ ==========
  
  // Пропускаем команды получения ID
  if (text === '/myid' || text === '/id') {
    await ctx.reply(`Ваш chat\\_id: \`${chatId}\``, { 
      parse_mode: 'MarkdownV2',
      ...removeKeyboard 
    });
    return;
  }
  
  // Если пользователь не админ - проверяем доступ
  if (!isAdmin(chatId)) {
    const { hasAccess } = await checkUserAccess(chatId);
    if (!hasAccess) {
      // Пропускаем только команды которые могут понадобиться без доступа
      const allowedCommands = ['/start', '/myid', '/id'];
      if (!allowedCommands.includes(text)) {
        await ctx.reply(
          `*❌ Доступ запрещен*\n\n` +
          `У вас нет активной подписки\\.\n` +
          `Для получения доступа обратитесь к администратору\\.\n\n` +
          `Ваш ID: \`${chatId}\`\n\n` +
          `📞 Контакт: @Seo\\_skayfol\\_analytics`,
          { 
            parse_mode: 'MarkdownV2',
            ...removeKeyboard 
          }
        );
        return;
      }
    }
  }
  
  // ========== ОБРАБОТКА ОСНОВНОГО МЕНЮ ==========
  
  // Пропускаем команды и кнопки основного меню
  const menuItems = [
    '🔑 Отправить API-ключ', '📊 Мой статус', '🏠 Главное меню',
    '📞 Связаться с поддержкой',
    '1. Meta', '2. Tik Tok', '3. Google', '4. Others', '↩️ Назад'
  ];
  
  if (text.startsWith('/') || menuItems.includes(text)) {
    // Обработка команд меню будет в отдельных обработчиках
    return;
  }
  
  const userState = userStates.get(chatId);
  
  // ========== ОБРАБОТКА API-КЛЮЧЕЙ ==========
  
  // Проверяем похоже ли на API-ключ и есть ли выбранная платформа
  if (text.length > 25 && /[a-zA-Z0-9._-]{25,}/.test(text) && userState?.waitingForKey) {
    console.log(`🔑 Попытка сохранения ключа от ${chatId} для платформы ${userState.platform}`);
    
    let customerDb;
    try {
      customerDb = await getCustomerDbConnection();
      
      // Проверка дубликата в БД заказчика
      const exists = await customerDb.query(
        'SELECT id, created_at FROM api_keys WHERE chat_id = $1 AND api_key = $2',
        [chatId, text]
      );
      
      if (exists.rows.length > 0) {
        const savedAt = new Date(exists.rows[0].created_at).toLocaleString('ru-RU');
        await ctx.reply(
          `*⚠️ Этот ключ уже был сохранён\\!*\n\n` +
          `_Дата сохранения: ${savedAt}_\n\n` +
          `Выберите действие:`,
          { 
            parse_mode: 'MarkdownV2',
            ...mainMenu 
          }
        );
        userStates.delete(chatId);
        return;
      }
      
      // Сохранение нового ключа в БД заказчика
      await customerDb.query(
        'INSERT INTO api_keys (chat_id, api_key, platform) VALUES ($1, $2, $3)',
        [chatId, text, userState.platform]
      );
      
      // Обновляем счетчик ключей в нашем кэше
      let ourDb;
      try {
        ourDb = await getOurDbConnection();
        await ourDb.query(
          `UPDATE user_cache 
           SET total_keys_sent = COALESCE(total_keys_sent, 0) + 1,
               updated_at = NOW()
           WHERE chat_id = $1`,
          [chatId]
        );
      } catch (error) {
        console.error('❌ Ошибка обновления счетчика ключей:', error);
      } finally {
        if (ourDb) await ourDb.end();
      }
      
      await ctx.reply(
        `*✅ Ключ успешно сохранён\\!*\n\n` +
        `Платформа: *${userState.platformDisplay}*\n` +
        `Мы начали обработку ваших данных\\.\n` +
        `Вы получите уведомление когда анализ будет готов\\.\n\n` +
        `_Обычно это занимает 5\\-15 минут_`,
        { 
          parse_mode: 'MarkdownV2',
          ...mainMenu 
        }
      );
      
      console.log(`✅ Ключ от ${chatId} сохранён для платформы ${userState.platform}`);
      
    } catch (error) {
      console.error('❌ Ошибка БД заказчика:', error);
      await ctx.reply(
        '*⚠️ Ошибка сервера*\n\nПожалуйста, попробуйте позже\\.',
        { 
          parse_mode: 'MarkdownV2',
          ...mainMenu 
        }
      );
    } finally {
      userStates.delete(chatId);
      if (customerDb) await customerDb.end();
    }
  } else if (userState?.waitingForKey) {
    // Пользователь ввёл не ключ, а что-то другое
    await ctx.reply(
      'Это не похоже на API\\-ключ\\. Отправьте длинную строку \\(от 30 символов\\)\\.',
      removeKeyboard
    );
  } else if (!isAdmin(chatId)) {
    // Не похоже на ключ и нет активного состояния - показываем меню (только для обычных пользователей)
    await ctx.reply(
      'Пожалуйста, используйте кнопки меню\\.',
      mainMenu
    );
  }
});

// ========== КНОПКА ГЛАВНОГО МЕНЮ ==========
async function showMainMenu(ctx) {
  const chatId = ctx.chat.id;
  const user = ctx.from;
  
  // Обновляем кэш пользователя
  await updateUserCache(chatId, user);
  
  // Проверяем доступ для обычных пользователей
  if (!isAdmin(chatId)) {
    const { hasAccess } = await checkUserAccess(chatId);
    if (!hasAccess) {
      await ctx.reply(
        `*❌ Доступ запрещен*\n\n` +
        `У вас нет активной подписки\\.\n` +
        `Для получения доступа обратитесь к администратору\\.\n\n` +
        `Ваш ID: \`${chatId}\`\n\n` +
        `📞 Контакт: @Seo\\_skayfol\\_analytics`,
        { 
          parse_mode: 'MarkdownV2',
          ...removeKeyboard 
        }
      );
      return;
    }
  }
  
  await ctx.reply(
    `*🔐 Skayfol Analytics*\n\n` +
    `Добро пожаловать в систему аналитики рекламных кампаний\\!\n\n` +
    `*Что умеет бот:*\n` +
    `✅ Принимает API\\-ключи от разных платформ\n` +
    `✅ Сохраняет в безопасное хранилище\n` +
    `✅ Уведомляет о результатах анализа`,
    { 
      parse_mode: 'MarkdownV2'
    }
  );
  
  // После приветствия показываем основное меню
  await ctx.reply('Выберите действие:', mainMenu);
}

bot.hears('🏠 Главное меню', async (ctx) => {
  console.log(`🔄 Главное меню от ${ctx.chat.id}`);
  await showMainMenu(ctx);
});

// ========== КНОПКА: СВЯЗАТЬСЯ С ПОДДЕРЖКОЙ ==========
bot.hears('📞 Связаться с поддержкой', async (ctx) => {
  const chatId = ctx.chat.id;
  
  if (!isAdmin(chatId)) {
    const { hasAccess } = await checkUserAccess(chatId);
    if (!hasAccess) {
      await ctx.reply(
        `*❌ Доступ запрещен*\n\n` +
        `У вас нет активной подписки\\.`,
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }
  }
  
  await ctx.reply(
    `Нажмите кнопку ниже, чтобы написать в поддержку:`,
    { 
      parse_mode: 'MarkdownV2',
      ...supportButton 
    }
  );
  
  // После inline-кнопки показываем основное меню
  await ctx.reply('Выберите действие:', mainMenu);
});

// ========== КНОПКА: ОТПРАВИТЬ API-КЛЮЧ ==========
bot.hears('🔑 Отправить API-ключ', async (ctx) => {
  const chatId = ctx.chat.id;
  
  if (!isAdmin(chatId)) {
    const { hasAccess } = await checkUserAccess(chatId);
    if (!hasAccess) {
      await ctx.reply(
        `*❌ Доступ запрещен*\n\n` +
        `У вас нет активной подписки\\.`,
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }
  }
  
  await ctx.reply(
    'Выберите платформу для которой добавляете API\\-ключ:',
    { 
      parse_mode: 'MarkdownV2',
      ...platformMenu 
    }
  );
});

// ========== КНОПКА: МОЙ СТАТУС ==========
bot.hears('📊 Мой статус', async (ctx) => {
  const chatId = ctx.chat.id;
  
  // Админ видит расширенную статистику
  if (isAdmin(chatId)) {
    const user = ctx.from;
    const adminName = user.username ? `@${user.username}` : user.first_name;
    const escapedName = escapeMarkdown(adminName);
    
    await ctx.reply(
      `*👑 Вы администратор \\(${escapedName}\\)*\n\n` +
      `Используйте команду /admin для управления системой\\.\n` +
      `Всего администраторов: ${ADMIN_CHAT_IDS.length}`,
      { 
        parse_mode: 'MarkdownV2',
        ...mainMenu 
      }
    );
    return;
  }
  
  // Для обычных пользователей проверяем доступ
  const { hasAccess, daysLeft, expiresAt } = await checkUserAccess(chatId);
  if (!hasAccess) {
    await ctx.reply(
      `*❌ Доступ запрещен*\n\n` +
      `У вас нет активной подписки\\.`,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }
  
  let customerDb;
  let ourDb;
  try {
    customerDb = await getCustomerDbConnection();
    const keysResult = await customerDb.query(
      `SELECT platform, COUNT(*) as count
       FROM api_keys 
       WHERE chat_id = $1
       GROUP BY platform
       ORDER BY platform`,
      [chatId]
    );
    
    // Получаем информацию о пользователе из кэша
    ourDb = await getOurDbConnection();
    const userCache = await ourDb.query(
      `SELECT username, first_name, total_keys_sent 
       FROM user_cache 
       WHERE chat_id = $1`,
      [chatId]
    );
    
    let message = '*📊 Ваш статус*\n\n';
    
    // Добавляем информацию о подписке
    const formattedDate = expiresAt ? expiresAt.toLocaleDateString('ru-RU') : 'Нет данных';
    message += `✅ *Подписка активна*\n`;
    message += `⏳ *Осталось дней:* ${daysLeft}\n`;
    message += `📅 *Истекает:* ${formattedDate}\n\n`;
    
    message += '*📊 Ваши ключи:*\n';
    
    if (keysResult.rows.length === 0) {
      message += 'У вас пока нет сохранённых ключей\\.\nИспользуйте кнопку "🔑 Отправить API\\-ключ" чтобы добавить первый ключ\\.';
    } else {
      const platformNames = {
        'meta': 'Meta',
        'tiktok': 'Tik Tok', 
        'google': 'Google',
        'others': 'Другие'
      };
      
      keysResult.rows.forEach(row => {
        const platformName = platformNames[row.platform] || row.platform;
        message += `• ${platformName}: ${row.count} ключей\n`;
      });
      
      const total = keysResult.rows.reduce((sum, row) => sum + parseInt(row.count), 0);
      message += `\n*Всего отправлено ключей: ${total}*`;
    }
    
    // Добавляем общую статистику если есть
    if (userCache.rows.length > 0 && userCache.rows[0].total_keys_sent) {
      message += `\n*Всего ключей за всё время: ${userCache.rows[0].total_keys_sent}*`;
    }
    
    await ctx.reply(
      message,
      { 
        parse_mode: 'MarkdownV2',
        ...mainMenu 
      }
    );
    
  } catch (error) {
    console.error('❌ Ошибка получения статуса:', error);
    await ctx.reply('⚠️ Не удалось получить статистику', mainMenu);
  } finally {
    if (customerDb) await customerDb.end();
    if (ourDb) await ourDb.end();
  }
});

// ========== ВЫБОР ПЛАТФОРМЫ ==========
bot.hears(['1. Meta', '2. Tik Tok', '3. Google', '4. Others'], async (ctx) => {
  const chatId = ctx.chat.id;
  
  if (!isAdmin(chatId)) {
    const { hasAccess } = await checkUserAccess(chatId);
    if (!hasAccess) {
      await ctx.reply(
        `*❌ Доступ запрещен*\n\n` +
        `У вас нет активной подписки\\.`,
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }
  }
  
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
  userStates.set(chatId, { 
    platform, 
    platformDisplay: platformNames[platform],
    waitingForKey: true 
  });
  
  await ctx.reply(
    `Выбрана платформа: *${platformNames[platform]}*\n\n` +
    `Теперь отправьте ваш API\\-ключ *одной строкой*\\.\n\n` +
    `*Пример формата:*\n` +
    `\`sk\\_test\\_51Nm\\.\\.\\.\` \\(тестовый ключ\\)\n` +
    `\`eyJ0eXAiOiJKV1QiLCJhbGciOiJ\\.\\.\\.\` \\(JWT токен\\)\n\n` +
    `_Ключ должен быть длинным \\(от 30 символов\\)_`,
    { 
      parse_mode: 'MarkdownV2',
      ...removeKeyboard 
    }
  );
});

// ========== КНОПКА НАЗАД ==========
bot.hears('↩️ Назад', async (ctx) => {
  const chatId = ctx.chat.id;
  
  if (!isAdmin(chatId)) {
    const { hasAccess } = await checkUserAccess(chatId);
    if (!hasAccess) {
      await ctx.reply(
        `*❌ Доступ запрещен*\n\n` +
        `У вас нет активной подписки\\.`,
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }
  }
  
  userStates.delete(chatId);
  await ctx.reply(
    'Выберите действие:',
    { 
      parse_mode: 'MarkdownV2',
      ...mainMenu 
    }
  );
});

// ========== ЗАПУСК СИСТЕМЫ ==========
let botStarted = false;

async function startBot() {
  try {
    // Очищаем старые webhook
    await bot.telegram.deleteWebhook();
    console.log('✅ Очищены старые webhook');
    
    // Запускаем проверку подписок по расписанию (каждый час)
    cron.schedule('0 * * * *', () => {
      console.log('🕐 Запуск проверки подписок...');
      checkExpiringSubscriptions();
    });
    
    console.log('⏰ Планировщик уведомлений запущен (каждый час)');
    
    await bot.launch();
    botStarted = true;
    console.log('✅ Бот запущен с системой подписок');
    console.log(`👑 Администраторы: ${ADMIN_CHAT_IDS.join(', ')}`);
    console.log(`📊 Используется 2 БД:`);
    console.log(`   • Наша БД: ${OUR_DB_URL ? '✅' : '❌'}`);
    console.log(`   • БД заказчика: ${CUSTOMER_DB_URL ? '✅' : '❌'}`);
    
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
  console.log(`🤖 Версия: 3.1 (система подписок + 2 БД + мульти-админ)`);
  console.log(`👑 Администраторы: ${ADMIN_CHAT_IDS.join(', ')}`);
  console.log(`🔐 Проверка доступа: ВКЛ`);
  console.log(`📢 Уведомления: ВКЛ (за 3 и 1 день)`);
  
  // Запускаем бота с задержкой
  setTimeout(() => {
    startBot().catch(console.error);
  }, 2000);
});

server.on('error', (error: any) => {
  console.error('❌ Ошибка сервера:', error.message);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Завершение работы...');
  if (botStarted) {
    bot.stop();
  }
  process.exit(0);
});

console.log('🚀 Система инициализирована');