-- Let retention find stale devices and abandoned sign-ups without scanning whole tables.
CREATE INDEX device_updated_at ON device(updated_at);
-- Partial: only unverified users are indexed, so verified sign-ins never pay for it.
CREATE INDEX user_unverified_createdAt ON user(createdAt) WHERE emailVerified = 0;
