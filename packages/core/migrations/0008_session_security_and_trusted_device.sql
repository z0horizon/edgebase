-- Account security audit timestamps on user, network + 2FA provenance on session (Better Auth
-- camelCase + ISO 8601 text), one-row-per-user twoFactor uniqueness, and the EdgeBase
-- trusted_device registry (snake_case + epoch ms).
ALTER TABLE user ADD COLUMN twoFactorEnabledAt TEXT;
ALTER TABLE user ADD COLUMN passwordChangedAt TEXT;

ALTER TABLE session ADD COLUMN asn INTEGER;
ALTER TABLE session ADD COLUMN asOrganization TEXT;
ALTER TABLE session ADD COLUMN country TEXT;
ALTER TABLE session ADD COLUMN city TEXT;
ALTER TABLE session ADD COLUMN createdIp TEXT;
ALTER TABLE session ADD COLUMN createdAsn INTEGER;
ALTER TABLE session ADD COLUMN createdAsOrganization TEXT;
ALTER TABLE session ADD COLUMN createdCountry TEXT;
ALTER TABLE session ADD COLUMN createdCity TEXT;
ALTER TABLE session ADD COLUMN lastActiveAt TEXT;
ALTER TABLE session ADD COLUMN twoFactorMethod TEXT
    CHECK (twoFactorMethod IN ('totp', 'backup_code', 'trusted_device'));
ALTER TABLE session ADD COLUMN twoFactorVerifiedAt TEXT;

DELETE FROM twoFactor
WHERE rowid NOT IN (SELECT MAX(rowid) FROM twoFactor GROUP BY userId);
DROP INDEX two_factor_user_id;
CREATE UNIQUE INDEX two_factor_user_id ON twoFactor(userId);

CREATE TABLE trusted_device (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    user_agent TEXT,
    ip_address TEXT,
    asn INTEGER,
    as_organization TEXT,
    country TEXT,
    city TEXT,
    created_ip TEXT,
    created_asn INTEGER,
    created_as_organization TEXT,
    created_country TEXT,
    created_city TEXT,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX trusted_device_user_id ON trusted_device(user_id);
CREATE INDEX trusted_device_expires_at ON trusted_device(expires_at);
