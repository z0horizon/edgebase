-- Inbox reads filter and sort by created_at; an index ending in id made them read and sort every
-- row the user has. Replacing it keeps one index, so writes cost the same.
DROP INDEX inbox_item_user;
CREATE INDEX inbox_item_user_created_at ON inbox_item(user_id, created_at, id);
