import { sql } from "../db/registry";
import { STATS_LISTED } from "./limits";
import type { Category, Platform } from "./types";

// Every statement of the push domain (devices, stats, opens, templates, scheduled pushes), named
// for the plan test and D1 metrics (see db/registry.ts). Callers run them; nothing runs here.

// --- device -------------------------------------------------------------------------------

const DEVICE_UPSERT = sql(
  "push.device.upsert",
  "DB",
  `INSERT INTO device (token, user_id, platform, updated_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(token) DO UPDATE SET
         user_id = excluded.user_id, platform = excluded.platform, updated_at = excluded.updated_at
       WHERE device.user_id <> excluded.user_id OR device.platform <> excluded.platform
          OR excluded.updated_at - device.updated_at >= ?5`,
);
/** Writes only when the owner or platform changed or the row is `refreshMs` old. */
export const upsertDeviceStmt = (
  db: D1Database,
  d: { token: string; userId: string; platform: Platform },
  now: number,
  refreshMs: number,
) => db.prepare(DEVICE_UPSERT).bind(d.token, d.userId, d.platform, now, refreshMs);

const DEVICE_TRIM = sql(
  "push.device.trimToNewest",
  "DB",
  `DELETE FROM device WHERE user_id = ?1 AND token NOT IN
           (SELECT token FROM device WHERE user_id = ?1 ORDER BY updated_at DESC LIMIT ?2)`,
);
/** Keeps a user's `keep` most recently refreshed devices. */
export const trimDevices = (db: D1Database, userId: string, keep: number) =>
  db.prepare(DEVICE_TRIM).bind(userId, keep);

const DEVICE_DELETE_OWN = sql(
  "push.device.deleteOwn",
  "DB",
  "DELETE FROM device WHERE token = ? AND user_id = ?",
);
export const deleteOwnDevice = (db: D1Database, token: string, userId: string) =>
  db.prepare(DEVICE_DELETE_OWN).bind(token, userId);

const DEVICE_OWNED = sql(
  "push.device.owned",
  "DB",
  "SELECT 1 FROM device WHERE token = ? AND user_id = ?",
);
export const deviceOwned = (db: D1Database, token: string, userId: string) =>
  db.prepare(DEVICE_OWNED).bind(token, userId);

const DEVICE_DELETE_TOKENS = sql(
  "push.device.deleteTokens",
  "DB",
  "DELETE FROM device WHERE token IN (SELECT value FROM json_each(?))",
);
export const deleteTokens = (db: D1Database, tokens: string[]) =>
  db.prepare(DEVICE_DELETE_TOKENS).bind(JSON.stringify(tokens));

const devicesSql = (byUser: boolean, marketing: boolean) =>
  `SELECT d.token, d.user_id FROM device d ${marketing ? "JOIN user u ON u.id = d.user_id" : ""}
       WHERE ${byUser ? "d.user_id" : "d.token"} IN (SELECT value FROM json_each(?)) ${
         marketing ? "AND u.marketingOptIn = 1" : ""
       }`;
for (const byUser of [true, false]) {
  for (const marketing of [true, false]) {
    sql(
      `push.device.targets.${byUser ? "byUser" : "byToken"}${marketing ? ".marketing" : ""}`,
      "DB",
      devicesSql(byUser, marketing),
    );
  }
}
/** The device rows of some users (or tokens); for marketing, only of users who opted in. */
export function deviceTargets(db: D1Database, keys: string[], byUser: boolean, marketing: boolean) {
  const text = devicesSql(byUser, marketing);
  return db.prepare(text).bind(JSON.stringify(keys));
}

// --- recipients -----------------------------------------------------------------------------

const recipientsSql = (marketing: boolean) =>
  `SELECT id, locale FROM user WHERE id IN (SELECT value FROM json_each(?))${
    marketing ? " AND marketingOptIn = 1" : ""
  }`;
sql("push.recipients", "DB", recipientsSql(false));
sql("push.recipients.marketing", "DB", recipientsSql(true));
/** Existing users among `ids` (one JSON parameter, any number of ids); for marketing, opted in. */
export const recipients = (db: D1Database, ids: string[], marketing: boolean) =>
  db.prepare(recipientsSql(marketing)).bind(JSON.stringify(ids));

// --- stats and opens ------------------------------------------------------------------------

const STATS_INSERT = sql(
  "push.stats.insert",
  "DB",
  "INSERT INTO push_stats (category, send_at) VALUES (?, ?) RETURNING id",
);
/** A new stats row for a push going out at `sendAt`; its id travels in the push as `data.pushId`. */
export const pushStatsInsert = (db: D1Database, category: Category, sendAt: number) =>
  db.prepare(STATS_INSERT).bind(category, sendAt);

const STATS_SET_USERS = sql(
  "push.stats.setUsers",
  "DB",
  "UPDATE push_stats SET users = ? WHERE id = ?",
);
export const setPushUsers = (db: D1Database, pushId: number, users: number) =>
  db.prepare(STATS_SET_USERS).bind(users, pushId);

const STATS_ADD_DELIVERIES = sql(
  "push.stats.addDeliveries",
  "DB",
  "UPDATE push_stats SET sent = sent + ?, failed = failed + ? WHERE id = ?",
);
export const addDeliveries = (db: D1Database, pushId: number, sent: number, failed: number) =>
  db.prepare(STATS_ADD_DELIVERIES).bind(sent, failed, pushId);

const STATS_COLUMNS = "id, category, users, sent, failed, opened, send_at AS sendAt";
const STATS_LIST = sql(
  "push.stats.listNewest",
  "DB",
  `SELECT ${STATS_COLUMNS} FROM push_stats ORDER BY id DESC LIMIT ${STATS_LISTED}`,
  { scanOk: "walks the rowid backwards and stops at STATS_LISTED rows" },
);
export const listPushStats = (db: D1Database) => db.prepare(STATS_LIST);

const STATS_GET = sql(
  "push.stats.get",
  "DB",
  `SELECT ${STATS_COLUMNS} FROM push_stats WHERE id = ?`,
);
export const getPushStats = (db: D1Database, id: number) => db.prepare(STATS_GET).bind(id);

const OPENS_RECORD = sql(
  "push.opens.record",
  "DB",
  `INSERT OR IGNORE INTO push_open (push_id, user_id)
       SELECT id, ?2 FROM push_stats WHERE id IN (SELECT CAST(value AS INTEGER) FROM json_each(?1))`,
);
/** Counts `userId` once per push opened; ids of pruned or unknown pushes write nothing. */
export const recordOpensStmt = (db: D1Database, userId: string, pushIds: string[]) =>
  db.prepare(OPENS_RECORD).bind(JSON.stringify(pushIds), userId);

const OPENS_UNCOUNT_USER = sql(
  "push.opens.uncountUser",
  "DB",
  `UPDATE push_stats SET opened = MAX(0, opened - 1)
         WHERE id IN (SELECT push_id FROM push_open WHERE user_id = ?)`,
);
const OPENS_DELETE_USER = sql(
  "push.opens.deleteUser",
  "DB",
  "DELETE FROM push_open WHERE user_id = ?",
);
/** Takes a deleted user's opens out of the counts, then deletes them. */
export const deleteUserOpensStmts = (db: D1Database, userId: string) => [
  db.prepare(OPENS_UNCOUNT_USER).bind(userId),
  db.prepare(OPENS_DELETE_USER).bind(userId),
];

// --- templates ------------------------------------------------------------------------------

const TEMPLATE_GET = sql(
  "push.template.get",
  "DB",
  "SELECT content FROM push_template WHERE name = ?",
);
export const getTemplateStmt = (db: D1Database, name: string) =>
  db.prepare(TEMPLATE_GET).bind(name);

const TEMPLATE_LIST = sql(
  "push.template.list",
  "DB",
  "SELECT name, content, updated_at FROM push_template ORDER BY name",
  { scanOk: "push_template is capped at MAX_TEMPLATES rows and listed whole" },
);
export const listTemplates = (db: D1Database) => db.prepare(TEMPLATE_LIST);

const TEMPLATE_PUT = sql(
  "push.template.put",
  "DB",
  `INSERT INTO push_template (name, content, updated_at) SELECT ?1, ?2, ?3
       WHERE (SELECT count(*) FROM push_template) < ?4
          OR EXISTS (SELECT 1 FROM push_template WHERE name = ?1)
       ON CONFLICT(name) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
  { scanOk: "count(*) over push_template, capped at MAX_TEMPLATES rows" },
);
/** An update always fits; a new name only while fewer than `max` templates exist. */
export const putTemplate = (
  db: D1Database,
  name: string,
  content: string,
  now: number,
  max: number,
) => db.prepare(TEMPLATE_PUT).bind(name, content, now, max);

const TEMPLATE_DELETE = sql(
  "push.template.delete",
  "DB",
  "DELETE FROM push_template WHERE name = ?",
);
export const deleteTemplate = (db: D1Database, name: string) =>
  db.prepare(TEMPLATE_DELETE).bind(name);

// --- scheduled pushes -----------------------------------------------------------------------

const SCHEDULED_INSERT = sql(
  "push.scheduled.insertAfterStats",
  "DB",
  `INSERT INTO scheduled_push (send_at, request, push_id)
       VALUES (?, ?, last_insert_rowid()) RETURNING id`,
);
/** Run right after pushStatsInsert in one batch: the row takes that stats row's id. */
export const insertScheduledAfterStats = (db: D1Database, sendAt: number, request: string) =>
  db.prepare(SCHEDULED_INSERT).bind(sendAt, request);

const SCHEDULED_DUE = sql(
  "push.scheduled.due",
  "DB",
  "SELECT id, request, push_id, send_at FROM scheduled_push WHERE send_at <= ? ORDER BY send_at LIMIT ?",
);
export const dueScheduled = (db: D1Database, now: number, limit: number) =>
  db.prepare(SCHEDULED_DUE).bind(now, limit);

const SCHEDULED_CLAIM = sql(
  "push.scheduled.claim",
  "DB",
  "UPDATE scheduled_push SET send_at = ? WHERE id = ? AND send_at = ?",
);
/** Moves a row's `send_at` from `from` to `until`, only if nobody changed it since. */
export const claimScheduled = (db: D1Database, id: number, from: number, until: number) =>
  db.prepare(SCHEDULED_CLAIM).bind(until, id, from);

const SCHEDULED_DELETE_HELD = sql(
  "push.scheduled.deleteHeld",
  "DB",
  "DELETE FROM scheduled_push WHERE id = ? AND send_at = ?",
);
export const deleteHeldScheduled = (db: D1Database, id: number, held: number) =>
  db.prepare(SCHEDULED_DELETE_HELD).bind(id, held);

const SCHEDULED_DELETE = sql(
  "push.scheduled.delete",
  "DB",
  "DELETE FROM scheduled_push WHERE id = ?",
);
export const deleteScheduled = (db: D1Database, id: number) =>
  db.prepare(SCHEDULED_DELETE).bind(id);

const SCHEDULED_SET_PUSH_ID = sql(
  "push.scheduled.setPushIdAfterStats",
  "DB",
  "UPDATE scheduled_push SET push_id = last_insert_rowid() WHERE id = ?",
);
/** Run right after pushStatsInsert in one batch, for rows stored before push stats existed. */
export const setScheduledPushIdAfterStats = (db: D1Database, id: number) =>
  db.prepare(SCHEDULED_SET_PUSH_ID).bind(id);
