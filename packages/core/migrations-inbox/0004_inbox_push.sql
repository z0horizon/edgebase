-- One row per push whose inbox rows are stored, written in the same transaction as them, so a
-- retried dispatch never writes a push's inbox twice. `id` is the push_stats id.
CREATE TABLE inbox_push (
    id INTEGER PRIMARY KEY,
    created_at INTEGER NOT NULL
);
