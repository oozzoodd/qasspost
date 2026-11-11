-- Миграция: печать чеков на термопринтере.
-- Текст сверху и снизу чека общий для всех касс точки (адрес, телефон, «Спасибо!»).
-- Ширина ленты и автопечать — настройка конкретного устройства, хранится в браузере кассы.
-- Безопасно для многократного выполнения.

ALTER TABLE venues ADD COLUMN IF NOT EXISTS receipt_header TEXT;
ALTER TABLE venues ADD COLUMN IF NOT EXISTS receipt_footer TEXT;
