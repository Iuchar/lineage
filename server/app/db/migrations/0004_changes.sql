-- Журнал правок рода. Каждая правка хранит записи GEDCOM, которых она коснулась, в виде «до» и «после»:
-- откат ставит «до» обратно, повтор — «после». Записи — источник истины: из них пересобираются таблицы
-- людей, семей и событий, и из них же строится экспорт без потерь.

CREATE TABLE changes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    clan_id    INTEGER NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
    summary    TEXT NOT NULL,
    created_at TEXT NOT NULL,
    undone     INTEGER NOT NULL DEFAULT 0,
    reverts    INTEGER REFERENCES changes(id) ON DELETE SET NULL,  -- «вернуть» из истории человека
    records    TEXT NOT NULL                                      -- JSON: [{k, id, x, b, a}]
);

-- кого правка касается: по этому строится история карточки; человека может уже не быть — без внешнего ключа
CREATE TABLE change_persons (
    change_id INTEGER NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
    person_id INTEGER NOT NULL,
    PRIMARY KEY (change_id, person_id)
);

CREATE INDEX changes_clan ON changes (clan_id, id);
CREATE INDEX change_persons_person ON change_persons (person_id);
