-- Срок действия ссылки зрителя. Ссылка больше не вечна: редактор выбирает срок при выпуске,
-- а гость, открывший её, получает доступ до того же дня и видит эту дату у себя.
ALTER TABLE share_links ADD COLUMN expires_at TEXT;
ALTER TABLE viewer_clans ADD COLUMN until TEXT;
-- выпущенные раньше ссылки и уже пришедшие по ним гости получают срок по умолчанию — 90 дней от обновления
UPDATE share_links SET expires_at = strftime('%Y-%m-%dT%H:%M:%S+00:00', 'now', '+90 days');
UPDATE viewer_clans SET until = strftime('%Y-%m-%dT%H:%M:%S+00:00', 'now', '+90 days');
