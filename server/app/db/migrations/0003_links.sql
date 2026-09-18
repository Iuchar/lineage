-- Межродовые связки: один человек, записанный в двух родах. Слияния людей не существует —
-- у каждого остаются свои данные, связка добавляет только переход и пометку «также в …».
-- Пара всегда хранится упорядоченной (a < b), чтобы одна связка не завелась дважды.

-- номер снятой связки не переходит к новой: интерфейс может держать старый номер
CREATE TABLE person_links (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    a_person_id INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    b_person_id INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    note        TEXT,
    visibility  TEXT NOT NULL DEFAULT 'common',   -- общий слой; уровни появятся с доступом
    created_by  TEXT,                              -- кто поставил; вход появится на этапе 4
    created_at  TEXT NOT NULL,
    CHECK (a_person_id < b_person_id),
    UNIQUE (a_person_id, b_person_id)
);

-- «разные люди»: решение запоминается, и пара больше не всплывает в подсказках
CREATE TABLE link_rejects (
    a_person_id INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    b_person_id INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    decided_at  TEXT NOT NULL,
    PRIMARY KEY (a_person_id, b_person_id),
    CHECK (a_person_id < b_person_id)
);

CREATE INDEX person_links_a ON person_links (a_person_id);
CREATE INDEX person_links_b ON person_links (b_person_id);
