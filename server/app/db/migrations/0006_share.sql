-- Ссылки зрителям. Ссылка выдаётся на род: открыл — считаешься своим для этого рода, открыл вторую —
-- свой для двух. Ссылка отзывается и выпускается заново, старая сразу перестаёт работать.

CREATE TABLE share_links (
    clan_id    INTEGER PRIMARY KEY REFERENCES clans(id) ON DELETE CASCADE,  -- одна действующая на род
    key        TEXT NOT NULL UNIQUE,  -- сам ключ: редактор должен видеть ссылку целиком в любой момент
    created_at TEXT NOT NULL,
    opened     INTEGER NOT NULL DEFAULT 0,
    opened_at  TEXT
);

-- Сессия зрителя: cookie хранит только ключ, роды лежат здесь. Одна сессия может быть своей для нескольких родов.
CREATE TABLE viewer_sessions (
    fingerprint TEXT PRIMARY KEY,
    created_at  TEXT NOT NULL,
    seen_at     TEXT NOT NULL
);

CREATE TABLE viewer_clans (
    fingerprint TEXT NOT NULL REFERENCES viewer_sessions(fingerprint) ON DELETE CASCADE,
    clan_id     INTEGER NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
    PRIMARY KEY (fingerprint, clan_id)
);
