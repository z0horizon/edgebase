-- Index names are ours to choose, so they follow the snake_case of our own tables even where the
-- Better Auth columns they cover are camelCase. SQLite cannot rename an index.
DROP INDEX session_userId;
CREATE INDEX session_user_id ON session(userId);
DROP INDEX session_expiresAt;
CREATE INDEX session_expires_at ON session(expiresAt);
DROP INDEX account_userId;
CREATE INDEX account_user_id ON account(userId);
DROP INDEX verification_expiresAt;
CREATE INDEX verification_expires_at ON verification(expiresAt);
DROP INDEX user_unverified_createdAt;
CREATE INDEX user_unverified_created_at ON user(createdAt) WHERE emailVerified = 0;
