import type { PushPayload } from "../push/types";

/** Removes everything the inbox holds for a user; INBOX_DB has no foreign key to `user`. */
export async function deleteUserInbox(db: D1Database, userId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM inbox_item WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM inbox_state WHERE user_id = ?").bind(userId),
  ]);
}

// D1 allows 100 bound parameters per statement; personal rows bind 6 each.
const PERSONAL_ROWS_PER_STATEMENT = 16;

const dataColumn = (p: PushPayload) => (p.data ? JSON.stringify(p.data) : null);

export async function insertPersonal(
  db: D1Database,
  userIds: string[],
  p: PushPayload,
  now: number,
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < userIds.length; i += PERSONAL_ROWS_PER_STATEMENT) {
    const chunk = userIds.slice(i, i + PERSONAL_ROWS_PER_STATEMENT);
    statements.push(
      db
        .prepare(
          `INSERT INTO inbox_item (user_id, title, body, data, category, created_at) VALUES ${chunk
            .map(() => "(?, ?, ?, ?, ?, ?)")
            .join(", ")}`,
        )
        .bind(...chunk.flatMap((id) => [id, p.title, p.body, dataColumn(p), p.category, now])),
    );
  }
  if (statements.length > 0) await db.batch(statements);
}

export async function insertBroadcast(db: D1Database, p: PushPayload, now: number): Promise<void> {
  await db
    .prepare(
      "INSERT INTO broadcast (title, body, data, category, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(p.title, p.body, dataColumn(p), p.category, now)
    .run();
}
