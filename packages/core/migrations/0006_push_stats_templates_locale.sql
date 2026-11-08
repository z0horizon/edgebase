-- One row per push; `send_at` is when it goes out, so a scheduled push is not pruned before it is sent.
CREATE TABLE push_stats (
    id INTEGER PRIMARY KEY,
    category TEXT NOT NULL,
    users INTEGER NOT NULL DEFAULT 0,
    sent INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    send_at INTEGER NOT NULL
);
CREATE INDEX push_stats_send_at ON push_stats(send_at);

-- One row per user who opened a push, so each user counts once.
CREATE TABLE push_open (
    push_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (push_id, user_id)
) WITHOUT ROWID;
-- Lets account deletion remove a user's opens without scanning the table.
CREATE INDEX push_open_user_id ON push_open(user_id);

ALTER TABLE scheduled_push ADD COLUMN push_id INTEGER;

CREATE TABLE push_template (
    name TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    updated_at INTEGER NOT NULL
) WITHOUT ROWID;

-- BCP 47 tag the user's notifications are written in; null uses each push's default text.
ALTER TABLE user ADD COLUMN locale TEXT;
