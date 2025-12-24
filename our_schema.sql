-- ============================================
-- БД ДЛЯ СИСТЕМЫ УПРАВЛЕНИЯ ДОСТУПОМ
-- Отдельная БД для нашего бота
-- ============================================

-- Таблица пользовательских доступов (подписок)
CREATE TABLE IF NOT EXISTS user_access (
  id SERIAL PRIMARY KEY,
  chat_id BIGINT UNIQUE NOT NULL,
  granted_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_by_admin_id BIGINT,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Логи действий администратора
CREATE TABLE IF NOT EXISTS admin_logs (
  id SERIAL PRIMARY KEY,
  admin_id BIGINT NOT NULL,
  action VARCHAR(100) NOT NULL,
  target_user_id BIGINT,
  details TEXT,
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Уведомления (чтобы не дублировать)
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  notification_type VARCHAR(50) NOT NULL,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, notification_type)
);

-- Кэш пользователей (опционально, для быстрого доступа)
CREATE TABLE IF NOT EXISTS user_cache (
  id SERIAL PRIMARY KEY,
  chat_id BIGINT UNIQUE NOT NULL,
  username VARCHAR(255),
  first_name VARCHAR(255),
  last_name VARCHAR(255),
  language_code VARCHAR(10),
  last_seen TIMESTAMP DEFAULT NOW(),
  total_keys_sent INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- НОВАЯ ТАБЛИЦА ДЛЯ ВОРОНКИ ПОЛЬЗОВАТЕЛЕЙ
-- ============================================

-- Таблица для хранения воронки пользователей (новый процесс)
CREATE TABLE IF NOT EXISTS user_funnel (
  id SERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  vertical VARCHAR(50),                    -- 🎰 Gambling / Betting и т.д.
  geo VARCHAR(100),                        -- GEO страна (например: RU, US, DE)
  source VARCHAR(50),                      -- Meta, TikTok, Google, Other
  conversion_price DECIMAL(10,2),          -- Ценовая конверсия (например: 50.00)
  api_key TEXT,                            -- API-ключ (если пользователь решил его добавить)
  current_step VARCHAR(50) DEFAULT 'vertical', -- Текущий шаг: vertical, geo, source, price, api_key
  is_completed BOOLEAN DEFAULT FALSE,      -- Воронка завершена
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  -- Связь с таблицей доступа
  FOREIGN KEY (chat_id) REFERENCES user_access(chat_id) ON DELETE CASCADE,
  
  -- Уникальность: один пользователь - одна активная воронка
  UNIQUE(chat_id) WHERE (NOT is_completed)
);

-- ============================================
-- ИНДЕКСЫ ДЛЯ БЫСТРОГО ПОИСКА
-- ============================================

-- Индексы для быстрого поиска
CREATE INDEX IF NOT EXISTS idx_user_access_chat_id ON user_access(chat_id);
CREATE INDEX IF NOT EXISTS idx_user_access_expires ON user_access(expires_at);
CREATE INDEX IF NOT EXISTS idx_user_access_active ON user_access(is_active, expires_at);
CREATE INDEX IF NOT EXISTS idx_user_access_combined ON user_access(chat_id, is_active, expires_at);

CREATE INDEX IF NOT EXISTS idx_admin_logs_admin_id ON admin_logs(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_logs_created ON admin_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_logs_action ON admin_logs(action);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_type ON notifications(notification_type);

CREATE INDEX IF NOT EXISTS idx_user_cache_chat_id ON user_cache(chat_id);
CREATE INDEX IF NOT EXISTS idx_user_cache_username ON user_cache(username);

-- Индексы для user_funnel
CREATE INDEX IF NOT EXISTS idx_user_funnel_chat_id ON user_funnel(chat_id);
CREATE INDEX IF NOT EXISTS idx_user_funnel_completed ON user_funnel(is_completed);
CREATE INDEX IF NOT EXISTS idx_user_funnel_step ON user_funnel(current_step);
CREATE INDEX IF NOT EXISTS idx_user_funnel_created ON user_funnel(created_at DESC);

-- ============================================
-- ФУНКЦИИ И ТРИГГЕРЫ
-- ============================================

-- Функция для автоматического обновления updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Триггер для user_access
DROP TRIGGER IF EXISTS update_user_access_updated_at ON user_access;
CREATE TRIGGER update_user_access_updated_at
    BEFORE UPDATE ON user_access
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Триггер для user_cache
DROP TRIGGER IF EXISTS update_user_cache_updated_at ON user_cache;
CREATE TRIGGER update_user_cache_updated_at
    BEFORE UPDATE ON user_cache
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Триггер для user_funnel
DROP TRIGGER IF EXISTS update_user_funnel_updated_at ON user_funnel;
CREATE TRIGGER update_user_funnel_updated_at
    BEFORE UPDATE ON user_funnel
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- ДЕМО ДАННЫЕ (опционально)
-- ============================================

-- Вставляем администратора (если нужно)
-- INSERT INTO user_access (chat_id, granted_at, expires_at, is_active, created_by_admin_id, notes)
-- VALUES (7909570066, NOW(), NOW() + INTERVAL '365 days', true, 7909570066, 'Главный администратор')
-- ON CONFLICT (chat_id) DO NOTHING;

-- ============================================
-- ПРОЦЕДУРЫ ДЛЯ АДМИНИСТРИРОВАНИЯ
-- ============================================

-- Процедура для добавления/продления доступа
CREATE OR REPLACE PROCEDURE add_user_access(
  p_chat_id BIGINT,
  p_admin_id BIGINT,
  p_days INTEGER DEFAULT 30,
  p_notes TEXT DEFAULT NULL
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_expires_at TIMESTAMP;
BEGIN
  -- Вычисляем дату истечения
  v_expires_at := NOW() + (p_days || ' days')::INTERVAL;
  
  -- Добавляем или обновляем доступ
  INSERT INTO user_access (chat_id, granted_at, expires_at, is_active, created_by_admin_id, notes)
  VALUES (p_chat_id, NOW(), v_expires_at, true, p_admin_id, p_notes)
  ON CONFLICT (chat_id)
  DO UPDATE SET
    expires_at = v_expires_at,
    is_active = true,
    created_by_admin_id = p_admin_id,
    notes = COALESCE(p_notes, user_access.notes),
    granted_at = CASE 
      WHEN user_access.expires_at < NOW() THEN NOW()
      ELSE user_access.granted_at
    END;
    
  -- Логируем действие
  INSERT INTO admin_logs (admin_id, action, target_user_id, details)
  VALUES (p_admin_id, 'add_access', p_chat_id, 
    jsonb_build_object('days', p_days, 'expires_at', v_expires_at));
    
  COMMIT;
END;
$$;

-- Процедура для деактивации доступа
CREATE OR REPLACE PROCEDURE deactivate_user_access(
  p_chat_id BIGINT,
  p_admin_id BIGINT,
  p_reason TEXT DEFAULT NULL
)
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE user_access 
  SET is_active = false,
      updated_at = NOW()
  WHERE chat_id = p_chat_id;
  
  INSERT INTO admin_logs (admin_id, action, target_user_id, details)
  VALUES (p_admin_id, 'deactivate_access', p_chat_id, 
    jsonb_build_object('reason', p_reason));
    
  COMMIT;
END;
$$;

-- Функция для проверки доступа
CREATE OR REPLACE FUNCTION check_user_access(p_chat_id BIGINT)
RETURNS TABLE(
  has_access BOOLEAN,
  days_left INTEGER,
  expires_at TIMESTAMP,
  is_active BOOLEAN
) 
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    TRUE as has_access,
    GREATEST(0, EXTRACT(DAY FROM (ua.expires_at - NOW())))::INTEGER as days_left,
    ua.expires_at,
    ua.is_active
  FROM user_access ua
  WHERE ua.chat_id = p_chat_id
    AND ua.is_active = true
    AND ua.expires_at > NOW()
  UNION ALL
  SELECT 
    FALSE, 0, NULL::TIMESTAMP, FALSE
  WHERE NOT EXISTS (
    SELECT 1 FROM user_access 
    WHERE chat_id = p_chat_id 
    AND is_active = true 
    AND expires_at > NOW()
  );
END;
$$;

-- Функция для получения активной воронки пользователя
CREATE OR REPLACE FUNCTION get_user_funnel(p_chat_id BIGINT)
RETURNS TABLE(
  funnel_id INTEGER,
  vertical VARCHAR,
  geo VARCHAR,
  source VARCHAR,
  conversion_price DECIMAL,
  api_key TEXT,
  current_step VARCHAR,
  is_completed BOOLEAN
) 
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    uf.id,
    uf.vertical,
    uf.geo,
    uf.source,
    uf.conversion_price,
    uf.api_key,
    uf.current_step,
    uf.is_completed
  FROM user_funnel uf
  WHERE uf.chat_id = p_chat_id
    AND uf.is_completed = false
  ORDER BY uf.created_at DESC
  LIMIT 1;
END;
$$;

-- ============================================
-- ПРЕДСТАВЛЕНИЯ ДЛЯ СТАТИСТИКИ
-- ============================================

-- Представление для статистики доступа
CREATE OR REPLACE VIEW access_stats AS
SELECT 
  COUNT(*) as total_users,
  COUNT(CASE WHEN is_active = true AND expires_at > NOW() THEN 1 END) as active_users,
  COUNT(CASE WHEN expires_at <= NOW() THEN 1 END) as expired_users,
  COUNT(CASE WHEN is_active = false THEN 1 END) as inactive_users,
  AVG(EXTRACT(DAY FROM (expires_at - granted_at)))::NUMERIC(5,1) as avg_duration_days,
  MIN(granted_at) as first_access_date,
  MAX(expires_at) as last_expiration_date
FROM user_access;

-- Представление для подписок, которые скоро истекут
CREATE OR REPLACE VIEW expiring_soon AS
SELECT 
  ua.chat_id,
  ua.expires_at,
  EXTRACT(DAY FROM (ua.expires_at - NOW()))::INTEGER as days_left,
  uc.username,
  uc.first_name
FROM user_access ua
LEFT JOIN user_cache uc ON ua.chat_id = uc.chat_id
WHERE ua.is_active = true
  AND ua.expires_at BETWEEN NOW() AND NOW() + INTERVAL '7 days'
ORDER BY ua.expires_at ASC;

-- Представление для статистики воронок
CREATE OR REPLACE VIEW funnel_stats AS
SELECT 
  COUNT(*) as total_funnels,
  COUNT(CASE WHEN is_completed = true THEN 1 END) as completed_funnels,
  COUNT(CASE WHEN is_completed = false THEN 1 END) as active_funnels,
  COUNT(CASE WHEN current_step = 'vertical' THEN 1 END) as on_vertical_step,
  COUNT(CASE WHEN current_step = 'geo' THEN 1 END) as on_geo_step,
  COUNT(CASE WHEN current_step = 'source' THEN 1 END) as on_source_step,
  COUNT(CASE WHEN current_step = 'price' THEN 1 END) as on_price_step,
  COUNT(CASE WHEN current_step = 'api_key' THEN 1 END) as on_api_key_step,
  
  -- Статистика по вертикалям
  COUNT(CASE WHEN vertical = 'Gambling / Betting' THEN 1 END) as gambling_count,
  COUNT(CASE WHEN vertical = 'Finance / MFO' THEN 1 END) as finance_count,
  COUNT(CASE WHEN vertical = 'Crypto / Forex' THEN 1 END) as crypto_count,
  COUNT(CASE WHEN vertical = 'Nutra / Beauty' THEN 1 END) as nutra_count,
  COUNT(CASE WHEN vertical = 'Dating / Adult' THEN 1 END) as dating_count,
  COUNT(CASE WHEN vertical = 'E-commerce' THEN 1 END) as ecommerce_count,
  COUNT(CASE WHEN vertical = 'Other' THEN 1 END) as other_vertical_count,
  
  -- Статистика по источникам
  COUNT(CASE WHEN source = 'Meta' THEN 1 END) as meta_count,
  COUNT(CASE WHEN source = 'TikTok' THEN 1 END) as tiktok_count,
  COUNT(CASE WHEN source = 'Google' THEN 1 END) as google_count,
  COUNT(CASE WHEN source = 'Other' THEN 1 END) as other_source_count,
  
  -- Статистика по GEO (топ 10 стран)
  (SELECT COUNT(*) FROM (
    SELECT geo, COUNT(*) as cnt 
    FROM user_funnel 
    WHERE geo IS NOT NULL 
    GROUP BY geo 
    ORDER BY cnt DESC 
    LIMIT 10
  ) as top_geo) as top_geo_count
FROM user_funnel;

-- Представление для незавершенных воронок (администраторам)
CREATE OR REPLACE VIEW unfinished_funnels AS
SELECT 
  uf.chat_id,
  uf.current_step,
  uf.vertical,
  uf.geo,
  uf.source,
  uf.conversion_price,
  uf.created_at,
  uc.username,
  uc.first_name
FROM user_funnel uf
LEFT JOIN user_cache uc ON uf.chat_id = uc.chat_id
WHERE uf.is_completed = false
  AND uf.created_at < NOW() - INTERVAL '1 hour'
ORDER BY uf.created_at ASC;