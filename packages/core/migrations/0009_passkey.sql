-- WebAuthn / FIDO2 credentials for `@better-auth/passkey` (Better Auth camelCase + ISO 8601 text).
-- Bounded at MAX_PASSKEYS_PER_USER (20) on write and cascaded on user deletion.
CREATE TABLE passkey (
    id TEXT PRIMARY KEY,
    name TEXT,
    publicKey TEXT NOT NULL,
    userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    credentialID TEXT NOT NULL,
    counter INTEGER NOT NULL,
    deviceType TEXT NOT NULL,
    backedUp INTEGER NOT NULL,
    transports TEXT,
    createdAt TEXT,
    aaguid TEXT
);
CREATE UNIQUE INDEX passkey_credential_id ON passkey(credentialID);
CREATE INDEX passkey_user_id ON passkey(userId);
