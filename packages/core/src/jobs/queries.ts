import { sql } from "../db/registry";

// Statements only the scheduled jobs run, named for the plan test and D1 metrics.

/** Deletes some users' inbox items from one inbox table (the legacy one or a week's). */
export const cleanupInboxItemsOfUsers = (table: string) =>
  sql(
    "jobs.cleanup.inboxItemsOfUsers",
    "INBOX_DB",
    `DELETE FROM ${table} WHERE user_id IN (SELECT value FROM json_each(?))`,
  );
cleanupInboxItemsOfUsers("inbox_item");

export const CLEANUP_INBOX_STATE_OF_USERS = sql(
  "jobs.cleanup.inboxStateOfUsers",
  "INBOX_DB",
  "DELETE FROM inbox_state WHERE user_id IN (SELECT value FROM json_each(?))",
);

export const CLEANUP_OPENS_OF_USERS = sql(
  "jobs.cleanup.opensOfUsers",
  "DB",
  "DELETE FROM push_open WHERE user_id IN (SELECT value FROM json_each(?))",
);

export const CLEANUP_UNCOUNT_OPENS_OF_USERS = sql(
  "jobs.cleanup.uncountOpensOfUsers",
  "DB",
  `WITH dec(push_id, n) AS (
      SELECT push_id, count(*) FROM push_open
      WHERE user_id IN (SELECT value FROM json_each(?1))
      GROUP BY push_id
    )
    UPDATE push_stats SET opened = MAX(0, opened - dec.n)
    FROM dec WHERE push_stats.id = dec.push_id`,
);

/** Rows one cleanup statement deletes at most; short chunks keep D1's single writer free. */
export const CLEANUP_CHUNK = 5000;

// Rowids grow with time, so everything below the first fresh rowid is expired. Capping the search
// window to CHUNK + 1 rows turns multi-chunk backlog deletes from O(M^2 / CHUNK) into O(M) while
// still stopping at the very first row when nothing has expired.
const byRowid = (table: string) =>
  `DELETE FROM ${table} WHERE id IN (
    SELECT id FROM ${table}
    WHERE id < COALESCE(
      (SELECT id FROM (SELECT id, created_at FROM ${table} ORDER BY id LIMIT ${CLEANUP_CHUNK + 1}) WHERE created_at >= ?1 LIMIT 1),
      9223372036854775807
    )
      AND created_at < ?1
    ORDER BY id LIMIT ${CLEANUP_CHUNK})`;

const expired = (table: string) =>
  `DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE expiresAt < ? LIMIT ${CLEANUP_CHUNK})`;

const ROWID_SCAN = "a rowid-ordered scan capped at CLEANUP_CHUNK + 1 rows";

/** The retention deletes of the hourly cleanup, each ending in RETURNING so chunks count rows. */
export const CLEANUP = {
  inbox: sql("jobs.cleanup.inbox", "INBOX_DB", `${byRowid("inbox_item")} RETURNING 1`, {
    scanOk: ROWID_SCAN,
  }),
  broadcast: sql("jobs.cleanup.broadcast", "INBOX_DB", `${byRowid("broadcast")} RETURNING 1`, {
    scanOk: ROWID_SCAN,
  }),
  inboxPush: sql("jobs.cleanup.inboxPush", "INBOX_DB", `${byRowid("inbox_push")} RETURNING 1`, {
    scanOk: ROWID_SCAN,
  }),
  session: sql("jobs.cleanup.session", "DB", `${expired("session")} RETURNING 1`),
  verification: sql("jobs.cleanup.verification", "DB", `${expired("verification")} RETURNING 1`),
  invitation: sql("jobs.cleanup.invitation", "DB", `${expired("invitation")} RETURNING 1`),
  device: sql(
    "jobs.cleanup.device",
    "DB",
    `DELETE FROM device WHERE token IN (SELECT token FROM device WHERE updated_at < ? LIMIT ${CLEANUP_CHUNK}) RETURNING 1`,
  ),
  trustedDevice: sql(
    "jobs.cleanup.trustedDevice",
    "DB",
    `DELETE FROM trusted_device WHERE id IN (SELECT id FROM trusted_device WHERE expires_at < ? LIMIT ${CLEANUP_CHUNK}) RETURNING 1`,
  ),
  unverified: sql(
    "jobs.cleanup.unverified",
    "DB",
    `DELETE FROM user WHERE id IN (
    SELECT u.id FROM user u WHERE u.emailVerified = 0 AND u.createdAt < ?
      AND NOT EXISTS (SELECT 1 FROM account a WHERE a.userId = u.id AND a.providerId <> 'credential')
    LIMIT ${CLEANUP_CHUNK}) RETURNING id`,
  ),
  scheduledPush: sql(
    "jobs.cleanup.scheduledPush",
    "DB",
    `DELETE FROM scheduled_push WHERE id IN (
    SELECT sp.id FROM scheduled_push sp
    LEFT JOIN push_stats ps ON ps.id = sp.push_id
    WHERE sp.send_at <= ?1 AND COALESCE(ps.send_at, sp.send_at) < ?2
    LIMIT ${CLEANUP_CHUNK}) RETURNING 1`,
  ),
  idempotency: sql(
    "jobs.cleanup.idempotency",
    "DB",
    `DELETE FROM push_idempotency WHERE key IN
    (SELECT key FROM push_idempotency WHERE created_at < ? LIMIT ${CLEANUP_CHUNK}) RETURNING 1`,
  ),
  pushOpen: sql(
    "jobs.cleanup.pushOpen",
    "DB",
    `DELETE FROM push_open WHERE (push_id, user_id) IN (
    SELECT push_id, user_id FROM push_open
    WHERE push_id IN (SELECT id FROM push_stats WHERE send_at < ?) LIMIT ${CLEANUP_CHUNK}) RETURNING 1`,
  ),
  pushStats: sql(
    "jobs.cleanup.pushStats",
    "DB",
    `DELETE FROM push_stats WHERE id IN (
    SELECT id FROM push_stats s WHERE send_at < ?
      AND NOT EXISTS (SELECT 1 FROM push_open o WHERE o.push_id = s.id)
    LIMIT ${CLEANUP_CHUNK}) RETURNING 1`,
  ),
} as const;
