import { STATS_KEPT_DAYS } from "../push/limits";

const CHUNK = 5000;
const DAY_MS = 86_400_000;
const DEVICE_STALE_DAYS = 60;
const UNVERIFIED_SIGNUP_DAYS = 7;
const IDEMPOTENCY_TTL_MS = DAY_MS;
const BUDGET_MS = 20_000;

type ChunkResult = { deleted: number; sizeAfter: number; rowsRead: number; complete: boolean };

/**
 * Runs `sql` (a DELETE limited to CHUNK rows by a sub-select, without RETURNING) until a run deletes fewer than CHUNK
 * rows or the deadline passes. Short chunks keep D1's single writer free for live traffic.
 */
async function deleteInChunks(
  db: D1Database,
  sql: string,
  params: unknown[],
  deadline: number,
): Promise<ChunkResult> {
  const out: ChunkResult = { deleted: 0, sizeAfter: 0, rowsRead: 0, complete: false };
  for (;;) {
    // Counted from RETURNING: D1's meta.changes also counts rows removed by ON DELETE CASCADE.
    const result = await db
      .prepare(`${sql} RETURNING 1`)
      .bind(...params)
      .all();
    out.deleted += result.results.length;
    out.sizeAfter = result.meta.size_after;
    out.rowsRead += result.meta.rows_read;
    if (result.results.length < CHUNK) {
      out.complete = true;
      return out;
    }
    if (Date.now() >= deadline) return out;
  }
}

type CleanupReport = {
  inbox: number;
  broadcast: number;
  inboxPush: number;
  session: number;
  verification: number;
  device: number;
  unverifiedUsers: number;
  invitation: number;
  idempotency: number;
  pushOpen: number;
  pushStats: number;
  rowsRead: number;
  /** False when the time budget ran out; the rest is deleted on the next run. */
  complete: boolean;
  dbBytes: number;
  inboxBytes: number;
};

// Rowids grow with time, so everything below the first fresh rowid is expired. Finding that
// rowid stops at the first fresh row, so neither query walks the fresh part of the table.
const byRowid = (table: string) =>
  `DELETE FROM ${table} WHERE id IN (
     SELECT id FROM ${table}
     WHERE id < COALESCE((SELECT id FROM ${table} WHERE created_at >= ?1 ORDER BY id LIMIT 1), 9223372036854775807)
       AND created_at < ?1
     ORDER BY id LIMIT ${CHUNK})`;

const expired = (table: string) =>
  `DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE expiresAt < ? LIMIT ${CHUNK})`;

export async function runCleanup(
  env: Env,
  now: number,
  budgetMs = BUDGET_MS,
): Promise<CleanupReport> {
  const deadline = Date.now() + budgetMs;
  const inboxCutoff = now - Number(env.INBOX_TTL_DAYS) * DAY_MS;
  // Better Auth stores dates as ISO 8601 text, which sorts like the instant it encodes.
  const iso = (ms: number) => new Date(ms).toISOString();

  const inbox = await deleteInChunks(env.INBOX_DB, byRowid("inbox_item"), [inboxCutoff], deadline);
  const broadcast = await deleteInChunks(
    env.INBOX_DB,
    byRowid("broadcast"),
    [inboxCutoff],
    deadline,
  );
  // Push ids grow with time like rowids, and a push past the inbox TTL is never retried.
  const inboxPush = await deleteInChunks(
    env.INBOX_DB,
    byRowid("inbox_push"),
    [inboxCutoff],
    deadline,
  );
  const session = await deleteInChunks(env.DB, expired("session"), [iso(now)], deadline);
  const verification = await deleteInChunks(env.DB, expired("verification"), [iso(now)], deadline);
  const device = await deleteInChunks(
    env.DB,
    `DELETE FROM device WHERE token IN (SELECT token FROM device WHERE updated_at < ? LIMIT ${CHUNK})`,
    [now - DEVICE_STALE_DAYS * DAY_MS],
    deadline,
  );
  // Email sign-ups never verified; users with any social account are kept, since a provider may
  // report its email unverified while the sign-in itself is real.
  const unverified = await deleteInChunks(
    env.DB,
    `DELETE FROM user WHERE id IN (
       SELECT u.id FROM user u WHERE u.emailVerified = 0 AND u.createdAt < ?
         AND NOT EXISTS (SELECT 1 FROM account a WHERE a.userId = u.id AND a.providerId <> 'credential')
       LIMIT ${CHUNK})`,
    [iso(now - UNVERIFIED_SIGNUP_DAYS * DAY_MS)],
    deadline,
  );

  const invitation = await deleteInChunks(env.DB, expired("invitation"), [iso(now)], deadline);
  const idempotency = await deleteInChunks(
    env.DB,
    `DELETE FROM push_idempotency WHERE key IN
       (SELECT key FROM push_idempotency WHERE created_at < ? LIMIT ${CHUNK})`,
    [now - IDEMPOTENCY_TTL_MS],
    deadline,
  );
  // Opens go first, and a stats row only once it has none left, so no open outlives its push.
  const statsCutoff = now - STATS_KEPT_DAYS * DAY_MS;
  const pushOpen = await deleteInChunks(
    env.DB,
    `DELETE FROM push_open WHERE (push_id, user_id) IN (
       SELECT push_id, user_id FROM push_open
       WHERE push_id IN (SELECT id FROM push_stats WHERE send_at < ?) LIMIT ${CHUNK})`,
    [statsCutoff],
    deadline,
  );
  const pushStats = await deleteInChunks(
    env.DB,
    `DELETE FROM push_stats WHERE id IN (
       SELECT id FROM push_stats s WHERE send_at < ?
         AND NOT EXISTS (SELECT 1 FROM push_open o WHERE o.push_id = s.id)
       LIMIT ${CHUNK})`,
    [statsCutoff],
    deadline,
  );

  const all = [
    inbox,
    broadcast,
    inboxPush,
    session,
    verification,
    device,
    unverified,
    invitation,
    idempotency,
    pushOpen,
    pushStats,
  ];
  const report: CleanupReport = {
    inbox: inbox.deleted,
    broadcast: broadcast.deleted,
    inboxPush: inboxPush.deleted,
    session: session.deleted,
    verification: verification.deleted,
    device: device.deleted,
    unverifiedUsers: unverified.deleted,
    invitation: invitation.deleted,
    idempotency: idempotency.deleted,
    pushOpen: pushOpen.deleted,
    pushStats: pushStats.deleted,
    rowsRead: all.reduce((sum, r) => sum + r.rowsRead, 0),
    complete: all.every((r) => r.complete),
    dbBytes: pushStats.sizeAfter,
    inboxBytes: inboxPush.sizeAfter,
  };
  if (report.complete) console.info("cleanup", JSON.stringify(report));
  else
    console.warn(
      "cleanup ran out of time; the rest waits for the next run",
      JSON.stringify(report),
    );
  return report;
}
