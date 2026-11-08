-- Columns and tables of the Better Auth admin, twoFactor and organization plugins, in their
-- camelCase. Dates are ISO 8601 text and booleans 0/1, as in 0001.
ALTER TABLE user ADD COLUMN role TEXT;
ALTER TABLE user ADD COLUMN banned INTEGER DEFAULT 0;
ALTER TABLE user ADD COLUMN banReason TEXT;
ALTER TABLE user ADD COLUMN banExpires TEXT;
ALTER TABLE user ADD COLUMN twoFactorEnabled INTEGER DEFAULT 0;
ALTER TABLE session ADD COLUMN impersonatedBy TEXT;
ALTER TABLE session ADD COLUMN activeOrganizationId TEXT;

CREATE TABLE twoFactor (
    id TEXT PRIMARY KEY,
    secret TEXT NOT NULL,
    backupCodes TEXT NOT NULL,
    userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    verified INTEGER DEFAULT 1,
    failedVerificationCount INTEGER DEFAULT 0,
    lockedUntil TEXT
);
CREATE INDEX two_factor_user_id ON twoFactor(userId);

CREATE TABLE organization (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    logo TEXT,
    metadata TEXT,
    createdAt TEXT NOT NULL
);

CREATE TABLE member (
    id TEXT PRIMARY KEY,
    organizationId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',
    createdAt TEXT NOT NULL
);
CREATE INDEX member_organization_id ON member(organizationId);
CREATE INDEX member_user_id ON member(userId);

CREATE TABLE invitation (
    id TEXT PRIMARY KEY,
    organizationId TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    role TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    expiresAt TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    inviterId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE
);
CREATE INDEX invitation_organization_id ON invitation(organizationId);
CREATE INDEX invitation_email ON invitation(email);
CREATE INDEX invitation_inviter_id ON invitation(inviterId);
CREATE INDEX invitation_expires_at ON invitation(expiresAt);

-- Only deleting a user's account can remove an organization's last member (Better Auth refuses to
-- let the last owner leave), and nobody can reach an organization without members.
CREATE TRIGGER member_last_removed AFTER DELETE ON member
WHEN NOT EXISTS (SELECT 1 FROM member WHERE organizationId = OLD.organizationId)
BEGIN
    DELETE FROM organization WHERE id = OLD.organizationId;
END;
