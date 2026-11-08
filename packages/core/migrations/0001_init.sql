-- Better Auth core tables. Better Auth writes dates as ISO 8601 text and booleans as 0/1 on SQLite.
CREATE TABLE user (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    emailVerified INTEGER NOT NULL DEFAULT 0,
    image TEXT,
    marketingOptIn INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
);

CREATE TABLE session (
    id TEXT PRIMARY KEY,
    expiresAt TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    ipAddress TEXT,
    userAgent TEXT,
    userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE
);
CREATE INDEX session_userId ON session(userId);
CREATE INDEX session_expiresAt ON session(expiresAt);

CREATE TABLE account (
    id TEXT PRIMARY KEY,
    accountId TEXT NOT NULL,
    providerId TEXT NOT NULL,
    userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    accessToken TEXT,
    refreshToken TEXT,
    idToken TEXT,
    accessTokenExpiresAt TEXT,
    refreshTokenExpiresAt TEXT,
    scope TEXT,
    password TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
);
CREATE INDEX account_userId ON account(userId);
CREATE UNIQUE INDEX account_provider_account ON account(providerId, accountId);

CREATE TABLE verification (
    id TEXT PRIMARY KEY,
    identifier TEXT NOT NULL,
    value TEXT NOT NULL,
    expiresAt TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
);
CREATE INDEX verification_identifier ON verification(identifier);
CREATE INDEX verification_expiresAt ON verification(expiresAt);

-- One row per FCM token; WITHOUT ROWID so the token key is the only B-tree besides user_id.
CREATE TABLE device (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    platform TEXT NOT NULL CHECK (platform IN ('web', 'ios', 'android')),
    updated_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX device_user ON device(user_id);

CREATE TABLE scheduled_push (
    id INTEGER PRIMARY KEY,
    send_at INTEGER NOT NULL,
    request TEXT NOT NULL
);
CREATE INDEX scheduled_push_send_at ON scheduled_push(send_at);
