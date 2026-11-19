-- Pre-aggregated unique open counter on push_stats so GET /v1/push reads 50 rows instead of
-- scanning push_open. Backfilled from existing rows and incremented only when INSERT OR IGNORE
-- actually inserts a new (push_id, user_id) pair.
ALTER TABLE push_stats ADD COLUMN opened INTEGER NOT NULL DEFAULT 0;
UPDATE push_stats SET opened = (SELECT count(*) FROM push_open WHERE push_id = push_stats.id);

CREATE TRIGGER push_open_inserted AFTER INSERT ON push_open
BEGIN
    UPDATE push_stats SET opened = opened + 1 WHERE id = NEW.push_id;
END;
