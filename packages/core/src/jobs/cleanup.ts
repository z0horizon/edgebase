import { inboxTtlDays } from "../config";
import {
  BUCKET_MS,
  bucketOf,
  dropExpiredBuckets,
  ensureBuckets,
  existingBucketTables,
  LEGACY_TABLE,
} from "../inbox/buckets";
import { STATS_KEPT_DAYS } from "../push/limits";
import {
  CLEANUP_CHUNK as CHUNK,
  CLEANUP,
  CLEANUP_INBOX_STATE_OF_USERS,
  CLEANUP_OPENS_OF_USERS,
  CLEANUP_UNCOUNT_OPENS_OF_USERS,
  cleanupInboxItemsOfUsers,
} from "./queries";
import { CLAIM_MS } from "./scheduled";

const DAY_MS = 86_400_000;
const DEVICE_STALE_DAYS = 60;
const UNVERIFIED_SIGNUP_DAYS = 7;
const IDEMPOTENCY_TTL_MS = DAY_MS;
const SCHEDULED_PUSH_TTL_MS = DAY_MS;
const BUDGET_MS = 20_000;

type ChunkResult = { deleted: number; sizeAfter: number; rowsRead: number; complete: boolean };

/**
 * Runs `sql` (a DELETE limited to CHUNK rows by a sub-select, with RETURNING) until a run deletes fewer than CHUNK
 * rows or the deadline passes. Short chunks keep D1's single writer free for live traffic.
 */
async function deleteInChunks<T = unknown>(
  db: D1Database,
  sql: string,
  params: unknown[],
  deadline: number,
  onChunk?: (rows: T[]) => Promise<void>,
): Promise<ChunkResult> {
  const out: ChunkResult = { deleted: 0, sizeAfter: 0, rowsRead: 0, complete: false };
  for (;;) {
    // Counted from RETURNING: D1's meta.changes also counts rows removed by ON DELETE CASCADE.
    const result = await db
      .prepare(sql)
      .bind(...params)
      .all<T>();
    if (result.results.length > 0 && onChunk) await onChunk(result.results);
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
  /** Rows deleted from the legacy inbox table, which empties as its items expire. */
  inbox: number;
  /** Week tables of personal inbox items dropped whole (no row writes). */
  inboxWeeks: number;
  broadcast: number;
  inboxPush: number;
  session: number;
  verification: number;
  device: number;
  trustedDevice: number;
  unverifiedUsers: number;
  scheduledPush: number;
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

const lastSize = (steps: ChunkResult[]) => steps.findLast((r) => r.sizeAfter > 0)?.sizeAfter ?? 0;

export async function runCleanup(
  env: Env,
  now: number,
  budgetMs = BUDGET_MS,
): Promise<CleanupReport> {
  const deadline = Date.now() + budgetMs;
  const inboxCutoff = now - inboxTtlDays(env) * DAY_MS;
  // Better Auth stores dates as ISO 8601 text, which sorts like the instant it encodes.
  const iso = (ms: number) => new Date(ms).toISOString();
  let timedOut = false;
  const step = async <T = unknown>(
    db: D1Database,
    sql: string,
    params: unknown[],
    onChunk?: (rows: T[]) => Promise<void>,
  ): Promise<ChunkResult> => {
    if (timedOut) return { deleted: 0, sizeAfter: 0, rowsRead: 0, complete: false };
    const res = await deleteInChunks(db, sql, params, deadline, onChunk);
    if (!res.complete || Date.now() >= deadline) timedOut = true;
    return res;
  };

  const inbox = await step(env.INBOX_DB, CLEANUP.inbox, [inboxCutoff]);
  // A week's table goes once its newest possible item is past the TTL, so items are kept up to
  // a week longer than INBOX_TTL_DAYS (reads still stop at the TTL). This week's and next week's
  // tables are made ahead, so inserts rarely find theirs missing.
  const weeks = await dropExpiredBuckets(env.INBOX_DB, inboxCutoff, deadline);
  if (!weeks.complete) timedOut = true;
  const inboxWeeks = weeks.dropped;
  await ensureBuckets(env.INBOX_DB, [bucketOf(now), bucketOf(now + BUCKET_MS)]);
  const broadcast = await step(env.INBOX_DB, CLEANUP.broadcast, [inboxCutoff]);
  // Push ids grow with time like rowids, and a push past the inbox TTL is never retried.
  const inboxPush = await step(env.INBOX_DB, CLEANUP.inboxPush, [inboxCutoff]);
  const session = await step(env.DB, CLEANUP.session, [iso(now)]);
  const verification = await step(env.DB, CLEANUP.verification, [iso(now)]);
  const device = await step(env.DB, CLEANUP.device, [now - DEVICE_STALE_DAYS * DAY_MS]);
  const trustedDevice = await step(env.DB, CLEANUP.trustedDevice, [now]);
  // Email sign-ups never verified; users with any social account are kept, since a provider may
  // report its email unverified while the sign-in itself is real.
  const unverified = await step<{ id: string }>(
    env.DB,
    CLEANUP.unverified,
    [iso(now - UNVERIFIED_SIGNUP_DAYS * DAY_MS)],
    async (rows) => {
      const ids = JSON.stringify(rows.map((r) => r.id));
      await Promise.all([
        env.INBOX_DB.batch([
          ...[LEGACY_TABLE, ...(await existingBucketTables(env.INBOX_DB))].map((t) =>
            env.INBOX_DB.prepare(cleanupInboxItemsOfUsers(t)).bind(ids),
          ),
          env.INBOX_DB.prepare(CLEANUP_INBOX_STATE_OF_USERS).bind(ids),
        ]),
        env.DB.batch([
          env.DB.prepare(CLEANUP_UNCOUNT_OPENS_OF_USERS).bind(ids),
          env.DB.prepare(CLEANUP_OPENS_OF_USERS).bind(ids),
        ]),
      ]);
    },
  );
  // Poison rows keep advancing scheduled_push.send_at on retry (up to CLAIM_MS ahead of now);
  // bounding sp.send_at first lets SQLite skip future pushes via scheduled_push_send_at.
  const scheduledPush = await step(env.DB, CLEANUP.scheduledPush, [
    now + CLAIM_MS,
    now - SCHEDULED_PUSH_TTL_MS,
  ]);
  const invitation = await step(env.DB, CLEANUP.invitation, [iso(now)]);
  const idempotency = await step(env.DB, CLEANUP.idempotency, [now - IDEMPOTENCY_TTL_MS]);
  // Opens go first, and a stats row only once it has none left, so no open outlives its push.
  const statsCutoff = now - STATS_KEPT_DAYS * DAY_MS;
  const pushOpen = await step(env.DB, CLEANUP.pushOpen, [statsCutoff]);
  const pushStats = await step(env.DB, CLEANUP.pushStats, [statsCutoff]);

  const inboxSteps = [inbox, broadcast, inboxPush];
  const dbSteps = [
    session,
    verification,
    device,
    trustedDevice,
    unverified,
    scheduledPush,
    invitation,
    idempotency,
    pushOpen,
    pushStats,
  ];
  const all = [...inboxSteps, ...dbSteps];
  const report: CleanupReport = {
    inbox: inbox.deleted,
    inboxWeeks,
    broadcast: broadcast.deleted,
    inboxPush: inboxPush.deleted,
    session: session.deleted,
    verification: verification.deleted,
    device: device.deleted,
    trustedDevice: trustedDevice.deleted,
    unverifiedUsers: unverified.deleted,
    scheduledPush: scheduledPush.deleted,
    invitation: invitation.deleted,
    idempotency: idempotency.deleted,
    pushOpen: pushOpen.deleted,
    pushStats: pushStats.deleted,
    rowsRead: all.reduce((sum, r) => sum + r.rowsRead, 0),
    complete: all.every((r) => r.complete) && weeks.complete,
    dbBytes: lastSize(dbSteps),
    inboxBytes: lastSize(inboxSteps),
  };
  if (report.complete) console.info({ event: "cleanup", ...report });
  else console.warn({ event: "cleanup_incomplete", ...report });
  return report;
}
