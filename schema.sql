-- Таблица для хранения API-ключей
CREATE TABLE IF NOT EXISTS api_keys (
  id SERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  api_key TEXT NOT NULL,
  platform TEXT DEFAULT 'unknown',
  account_name TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  status TEXT DEFAULT 'pending' -- pending, processing, completed, error
);

-- Индекс для быстрого поиска по chat_id
CREATE INDEX IF NOT EXISTS idx_api_keys_chat_id ON api_keys(chat_id);