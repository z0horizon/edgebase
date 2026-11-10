-- Inbox reads filter and sort broadcasts by created_at; without this every read scanned and
-- sorted the whole table. Broadcasts are few, so the extra write per insert and delete is cheap.
CREATE INDEX broadcast_created_at ON broadcast(created_at, id);
