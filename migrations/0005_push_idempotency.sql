-- One row per Idempotency-Key on POST /v1/push; `response` is null while the first request runs.
CREATE TABLE push_idempotency (
    key TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    response TEXT,
    created_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX push_idempotency_created_at ON push_idempotency(created_at);
