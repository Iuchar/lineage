-- Роды, люди, семьи, события и справочник мест.
-- Идентификаторы из файла (xref) уникальны только внутри рода и между родами не сравниваются.
-- Поле raw хранит запись GEDCOM целиком: из неё экспорт вернёт всё, чему нет своего поля.

CREATE TABLE clans (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    source_file TEXT,
    imported_at TEXT NOT NULL,
    header_raw  TEXT            -- запись HEAD как дерево JSON
);

CREATE TABLE places (
    id        INTEGER PRIMARY KEY,
    name      TEXT NOT NULL UNIQUE,
    latitude  REAL,
    longitude REAL
);

CREATE TABLE persons (
    id              INTEGER PRIMARY KEY,
    clan_id         INTEGER NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
    xref            TEXT NOT NULL,
    uid             TEXT,
    name_raw        TEXT,
    given           TEXT,
    surname         TEXT,
    married_surname TEXT,
    sex             TEXT CHECK (sex IN ('M', 'F', 'U')),
    is_branch_stub  INTEGER NOT NULL DEFAULT 0,
    raw             TEXT NOT NULL,
    UNIQUE (clan_id, xref)
);

CREATE TABLE families (
    id         INTEGER PRIMARY KEY,
    clan_id    INTEGER NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
    xref       TEXT NOT NULL,
    uid        TEXT,
    husband_id INTEGER REFERENCES persons(id) ON DELETE SET NULL,
    wife_id    INTEGER REFERENCES persons(id) ON DELETE SET NULL,
    raw        TEXT NOT NULL,
    UNIQUE (clan_id, xref)
);

-- порядок FAMS у человека — это порядок его браков
CREATE TABLE spouse_families (
    person_id INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
    position  INTEGER NOT NULL,
    PRIMARY KEY (person_id, family_id)
);

CREATE TABLE family_children (
    family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
    person_id INTEGER NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    position  INTEGER NOT NULL,
    pedigree  TEXT,             -- PEDI из записи ребёнка: birth, adopted, foster…
    PRIMARY KEY (family_id, person_id)
);

CREATE TABLE events (
    id             INTEGER PRIMARY KEY,
    person_id      INTEGER REFERENCES persons(id) ON DELETE CASCADE,
    family_id      INTEGER REFERENCES families(id) ON DELETE CASCADE,
    position       INTEGER NOT NULL,
    tag            TEXT NOT NULL,
    type           TEXT,
    value          TEXT,
    date_raw       TEXT,
    date_kind      TEXT,
    date_year      INTEGER,
    date_month     INTEGER,
    date_day       INTEGER,
    date_end_year  INTEGER,
    date_end_month INTEGER,
    date_end_day   INTEGER,
    date_phrase    TEXT,
    place_id       INTEGER REFERENCES places(id),
    CHECK ((person_id IS NULL) <> (family_id IS NULL))
);

-- прочие записи верхнего уровня: NOTE, SOUR, OBJE, REPO, SUBM…
CREATE TABLE extra_records (
    id       INTEGER PRIMARY KEY,
    clan_id  INTEGER NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    tag      TEXT NOT NULL,
    xref     TEXT,
    raw      TEXT NOT NULL
);

CREATE INDEX persons_clan ON persons (clan_id);
CREATE INDEX families_clan ON families (clan_id);
CREATE INDEX events_person ON events (person_id);
CREATE INDEX events_family ON events (family_id);
CREATE INDEX family_children_person ON family_children (person_id);
