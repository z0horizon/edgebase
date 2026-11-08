const CHUNK = 5000;
const DAY_MS = 86_400_000;
const DEVICE_STALE_DAYS = 60;
const BUDGET_MS = 20_000;

/**
 * Runs `sql` (a DELETE limited to CHUNK rows by a sub-select) until a run deletes fewer than CHUNK
 * rows or the deadline passes. Short chunks keep D1's single writer free for live traffic.
 */
export async function deleteInChunks(
  db: D1Database,
  sql: string,
  params: unknown[],
  deadline: number,
): Promise<{ deleted: number; sizeAfter: number }> {
  let deleted = 0;
  let sizeAfter = 0;
  for (;;) {
    const result = await db
      .prepare(sql)
      .bind(...params)
      .run();
    deleted += result.meta.changes;
    sizeAfter = result.meta.size_after;
    if (result.meta.changes < CHUNK || Date.now() >= deadline) break;
  }
  return { deleted, sizeAfter };
}

export type CleanupReport = {
  inbox: number;
  broadcast: number;
  session: number;
  verification: number;
  device: number;
  dbBytes: number;
  inboxBytes: number;
};

export async function runCleanup(env: Env, now: number): Promise<CleanupReport> {
  const deadline = Date.now() + BUDGET_MS;
  const inboxCutoff = now - Number(env.INBOX_TTL_DAYS) * DAY_MS;
  // Better Auth stores dates as ISO 8601 text, which sorts like the instant it encodes.
  const nowIso = new Date(now).toISOString();
  // Rowids grow with time, so ORDER BY id reaches the expired rows first.
  const byRowid = (table: string) =>
    `DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE created_at < ? ORDER BY id LIMIT ${CHUNK})`;
  const expired = (table: string) =>
    `DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE expiresAt < ? LIMIT ${CHUNK})`;

  const inbox = await deleteInChunks(env.INBOX_DB, byRowid("inbox_item"), [inboxCutoff], deadline);
  const broadcast = await deleteInChunks(
    env.INBOX_DB,
    byRowid("broadcast"),
    [inboxCutoff],
    deadline,
  );
  const session = await deleteInChunks(env.DB, expired("session"), [nowIso], deadline);
  const verification = await deleteInChunks(env.DB, expired("verification"), [nowIso], deadline);
  const device = await deleteInChunks(
    env.DB,
    `DELETE FROM device WHERE token IN (SELECT token FROM device WHERE updated_at < ? LIMIT ${CHUNK})`,
    [now - DEVICE_STALE_DAYS * DAY_MS],
    deadline,
  );

  const report: CleanupReport = {
    inbox: inbox.deleted,
    broadcast: broadcast.deleted,
    session: session.deleted,
    verification: verification.deleted,
    device: device.deleted,
    dbBytes: device.sizeAfter,
    inboxBytes: broadcast.sizeAfter,
  };
  console.info("cleanup", JSON.stringify(report));
  return report;
}
