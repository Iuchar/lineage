-- Доступ: редакторы входят по имени и паролю, зритель приходит по ссылке (ссылки — следующим шагом).
-- Пока в базе нет ни одного редактора, приложение работает как раньше: правка открыта всем, кто дошёл
-- до страницы. Как только заведён первый редактор, любое изменение требует входа.

CREATE TABLE editors (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    secret     TEXT NOT NULL,  -- scrypt$n$r$p$соль$хеш, сам пароль нигде не хранится
    created_at TEXT NOT NULL
);

-- Вход выдаёт долгую сессию. В базе лежит только отпечаток ключа: утечка таблицы не даёт войти.
CREATE TABLE sessions (
    fingerprint TEXT PRIMARY KEY,
    editor_id   INTEGER NOT NULL REFERENCES editors(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL,
    seen_at     TEXT NOT NULL
);

CREATE INDEX sessions_editor ON sessions(editor_id);
