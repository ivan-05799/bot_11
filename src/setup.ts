import { Client } from 'pg';
import * as readline from 'readline';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(query, resolve);
  });
}

async function setupBot() {
  console.log('\n🤖 === Настройка Telegram-бота для сбора API-ключей ===\n');

  // Шаг 1: Токен бота
  let botToken = '';
  while (!botToken) {
    botToken = await question('Введите токен бота: ');
    if (!botToken) {
      console.log('❌ Токен не может быть пустым');
    }
  }

  // Проверка токена
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
    const data = await response.json();
    if (!data.ok) {
      throw new Error('Неверный токен');
    }
    console.log(`✅ Токен валиден! Бот: @${data.result.username}`);
  } catch (error) {
    console.log('❌ Неверный токен бота');
    process.exit(1);
  }

  // Шаг 2: База данных
  let dbUrl = '';
  while (!dbUrl) {
    dbUrl = await question('Введите строку подключения к PostgreSQL: ');
    if (!dbUrl) {
      console.log('❌ Строка подключения не может быть пустой');
    }
  }

  // Проверка подключения к БД
  const db = new Client({ connectionString: dbUrl });
  try {
    await db.connect();
    console.log('✅ Подключение к базе данных успешно!');

    // Создание таблицы api_keys
    await db.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id SERIAL PRIMARY KEY,
        chat_id BIGINT NOT NULL,
        api_key TEXT NOT NULL,
        platform TEXT DEFAULT 'unknown',
        account_name TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        status TEXT DEFAULT 'pending'
      );
      
      CREATE INDEX IF NOT EXISTS idx_api_keys_chat_id ON api_keys(chat_id);
    `);
    console.log('✅ Таблица api_keys создана/проверена');

  } catch (error) {
    console.log('❌ Ошибка подключения к базе данных:', error);
    process.exit(1);
  } finally {
    await db.end();
  }

  // Сохранение в .env
  const envContent = `BOT_TOKEN=${botToken}\nDATABASE_URL=${dbUrl}\n`;
  fs.writeFileSync('.env', envContent);
  console.log('✅ Файл .env создан!');

  console.log('\n✅ === Настройка завершена! ===');
  console.log('Теперь вы можете запустить бота:');
  console.log('  npm run dev   - режим разработки');
  console.log('  npm start     - продакшн\n');

  rl.close();
}

setupBot().catch(console.error);