-- Integer rowids grow with time, so they double as the cursor and let retention delete oldest-first.
CREATE TABLE inbox_item (
    id INTEGER PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    data TEXT,
    category TEXT NOT NULL,
    read_at INTEGER,
    created_at INTEGER NOT NULL
);
CREATE INDEX inbox_item_user ON inbox_item(user_id, id);

-- One row per broadcast, never fanned out per user.
CREATE TABLE broadcast (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    data TEXT,
    category TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

-- "Read all" watermark per user.
CREATE TABLE inbox_state (
    user_id TEXT PRIMARY KEY,
    read_at INTEGER NOT NULL
) WITHOUT ROWID;
