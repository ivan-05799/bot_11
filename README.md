# Telegram Analytics Bot

Telegram-бот для отправки уведомлений из системы аналитики.

## Установка

1. Установите зависимости:
```bash
npm install
```

2. Запустите интерактивную настройку:
```bash
npm run setup
```

Скрипт настройки:
- Проверит валидность токена бота (запрос к Telegram API)
- Проверит подключение к базе данных
- Автоматически создаст таблицу `telegram_users` (если нужно)
- Сохранит настройки в `.env` файл

### Ручная настройка (альтернатива)

Если предпочитаете настроить вручную:

1. Создайте бота у [@BotFather](https://t.me/BotFather)
2. Скопируйте `.env.example` в `.env`
3. Заполните переменные окружения
4. Создайте таблицу: `psql $DATABASE_URL -f schema.sql`

## Запуск

Режим разработки (с автоперезагрузкой):
```bash
npm run dev
```

Продакшн:
```bash
npm run build
npm start
```

## Использование

### Запуск бота
Бот работает в режиме Long Polling и слушает команды пользователей.

### Отправка уведомлений из вашего кода

```typescript
import { sendAlertToAll, sendAlertToUser } from './notifier';

// Отправить всем подписчикам
await sendAlertToAll('⚠️ *Кампания X убыточна*\nСоветую остановить!');

// Отправить конкретному пользователю
await sendAlertToUser(123456789, '✅ Анализ завершен!');
```

## Интеграция с Trigger.dev

В вашем Trigger.dev задании:

```typescript
import { sendAlertToAll } from './path/to/notifier';

// В вашей задаче
if (campaign.isUnprofitable) {
  await sendAlertToAll(
    `⚠️ *Кампания "${campaign.name}" убыточна*\n\n` +
    `ROI: ${campaign.roi}%\n` +
    `Советую остановить!`
  );
}
```
