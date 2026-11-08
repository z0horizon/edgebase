/** Removes everything the inbox holds for a user; INBOX_DB has no foreign key to `user`. */
export async function deleteUserInbox(db: D1Database, userId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM inbox_item WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM inbox_state WHERE user_id = ?").bind(userId),
  ]);
}
