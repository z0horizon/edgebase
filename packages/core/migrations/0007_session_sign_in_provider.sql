-- The social provider (google, github, apple) that created a session, or NULL for email +
-- password. Admin features accept a social session without the account's own TOTP.
ALTER TABLE session ADD COLUMN signInProvider TEXT;
