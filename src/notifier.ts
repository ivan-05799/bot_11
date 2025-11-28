import { Telegraf } from 'telegraf';
import { Client } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);

/**
 * Отправляет уведомление пользователю по chat_id
 * @param chatId - ID чата пользователя
 * @param message - Текст сообщения
 */
export async function sendAlertToUser(chatId: number, message: string) {
  try {
    await bot.telegram.sendMessage(chatId, message, { 
      parse_mode: 'Markdown' 
    });
    console.log(`✅ Уведомление отправлено пользователю ${chatId}`);
  } catch (e) {
    console.error(`❌ Не удалось отправить пользователю ${chatId}:`, e);
    throw e;
  }
}

/**
 * Отправляет статус обработки API-ключа пользователю
 * @param chatId - ID чата пользователя
 * @param status - Статус обработки
 * @param details - Дополнительные детали
 */
export async function sendProcessingStatus(
  chatId: number, 
  status: 'processing' | 'completed' | 'error', 
  details?: string
) {
  const messages = {
    processing: '🔄 *Ваши данные обрабатываются*\n\nМы анализируем вашу рекламную статистику. Это займет несколько минут...',
    completed: '✅ *Аналитика готова!*\n\nРезультаты анализа ваших рекламных кампаний готовы.',
    error: '❌ *Ошибка обработки*\n\nНе удалось обработать ваш API-ключ. Пожалуйста, проверьте ключ и попробуйте снова.'
  };

  let message = messages[status];
  if (details) {
    message += `\n\n${details}`;
  }

  await sendAlertToUser(chatId, message);
}

/**
 * Отправляет результаты аналитики пользователю
 * @param chatId - ID чата пользователя
 * @param analyticsData - Данные аналитики
 */
export async function sendAnalyticsResults(chatId: number, analyticsData: any) {
  try {
    // Формируем сообщение с результатами
    const message = `
📊 *Результаты аналитики*

*Кампаний проанализировано:* ${analyticsData.campaignsCount}
*Период анализа:* ${analyticsData.period}

*Топ кампании:*
${analyticsData.topCampaigns.map((camp: any, index: number) => 
  `${index + 1}. ${camp.name} - ROI: ${camp.roi}%`
).join('\n')}

*Рекомендации:*
${analyticsData.recommendations.join('\n• ')}

Для детальных отчетов посетите панель аналитики.
    `.trim();

    await sendAlertToUser(chatId, message);
  } catch (e) {
    console.error(`❌ Ошибка отправки аналитики пользователю ${chatId}:`, e);
    throw e;
  }
}

/**
 * Обновляет статус API-ключа в базе и уведомляет пользователя
 * @param chatId - ID чата пользователя
 * @param apiKeyId - ID API-ключа в базе
 * @param status - Новый статус
 */
export async function updateApiKeyStatus(
  chatId: number, 
  apiKeyId: number, 
  status: 'processing' | 'completed' | 'error'
) {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  try {
    // Обновляем статус в базе
    await db.query(
      'UPDATE api_keys SET status = $1 WHERE id = $2',
      [status, apiKeyId]
    );

    // Отправляем уведомление пользователю
    await sendProcessingStatus(chatId, status);
    
    console.log(`✅ Статус API-ключа ${apiKeyId} обновлен на: ${status}`);
  } finally {
    await db.end();
  }
}