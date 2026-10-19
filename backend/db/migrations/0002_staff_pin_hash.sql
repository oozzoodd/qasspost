-- Миграция: PIN сотрудников хранится как bcrypt-хеш (~60 символов) вместо 4 цифр
-- Безопасно для многократного выполнения
ALTER TABLE staff ALTER COLUMN pin TYPE VARCHAR(100);
