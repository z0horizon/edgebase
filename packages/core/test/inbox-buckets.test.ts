import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inboxTtlDays } from "../src/config";
import { metered } from "../src/db/metrics";
import {
  BUCKET_MS,
  bucketOf,
  bucketOfId,
  bucketTable,
  dropExpiredBuckets,
  existingBucketTables,
  LEGACY_TABLE,
} from "../src/inbox/buckets";
import {
  deleteItem,
  insertPersonal,
  listInbox,
  listInboxWithUnread,
  markRead,
  markReadStatements,
  unreadCount,
  writeInboxOnce,
} from "../src/inbox/queries";
import { runCleanup } from "../src/jobs/cleanup";
import { inboxRows, seedUser } from "./helpers";

const DAY = 86_400_000;
const TTL = 30;
let n = 0;
const uid = () => `bucket-user-${++n}`;
const p = (title: string) => ({ title, body: "b", category: "transactional" as const });
const q = (now: number, userId: string) => ({
  userId,
  userCreatedAt: now - 400 * DAY,
  cursor: null,
  limit: 20,
  now,
  ttlDays: TTL,
  marketingOptIn: true,
});
/** A time base far from other tests' weeks, so tables made or dropped here touch no one else. */
let bases = 0;
const base = () => Date.UTC(2031, 0, 1) + ++bases * 20 * 7 * DAY;

afterEach(() => vi.restoreAllMocks());

const tableExists = async (table: string) =>
  (await existingBucketTables(env.INBOX_DB)).includes(table);

describe("inbox weeks", () => {
  it("stores an item in its week's table, under an id that names the week", async () => {
    const now = base();
    const u = uid();
    await insertPersonal(env.INBOX_DB, [u], p("this week"), now);
    expect(await tableExists(bucketTable(bucketOf(now)))).toBe(true);
    const [item] = (await listInbox(env.INBOX_DB, q(now, u))).items;
    const id = Number(item?.id.slice(2));
    expect(item?.id).toMatch(/^p_\d+$/);
    expect(bucketOfId(id)).toBe(bucketOf(now));
  });

  it("reads, marks and deletes across the legacy table and several weeks", async () => {
    const now = base();
    const u = uid();
    await env.INBOX_DB.prepare(
      `INSERT INTO ${LEGACY_TABLE} (user_id, title, body, category, created_at) VALUES (?, 'legacy', 'b', 'transactional', ?)`,
    )
      .bind(u, now - 20 * DAY)
      .run();
    await insertPersonal(env.INBOX_DB, [u], p("two weeks ago"), now - 14 * DAY);
    await insertPersonal(env.INBOX_DB, [u], p("today"), now - 1000);
    const page = await listInbox(env.INBOX_DB, q(now, u));
    expect(page.items.map((i) => i.title)).toEqual(["today", "two weeks ago", "legacy"]);
    expect(await unreadCount(env.INBOX_DB, q(now, u))).toBe(3);

    const ids = page.items.map((i) => Number(i.id.slice(2)));
    await markRead(env.INBOX_DB, u, ids.slice(0, 2), now, TTL);
    expect(await unreadCount(env.INBOX_DB, q(now, u))).toBe(1);
    expect(await deleteItem(env.INBOX_DB, u, ids[2] ?? 0, now, TTL)).toBe(true);
    expect(await deleteItem(env.INBOX_DB, "someone-else", ids[0] ?? 0, now, TTL)).toBe(false);
    expect((await listInbox(env.INBOX_DB, q(now, u))).items.map((i) => i.title)).toEqual([
      "today",
      "two weeks ago",
    ]);
  });

  it("pages through weeks in order with the cursor", async () => {
    const now = base();
    const u = uid();
    for (let i = 0; i < 25; i++) await insertPersonal(env.INBOX_DB, [u], p(`i${i}`), now - i * DAY);
    const seen: string[] = [];
    let cursor = null;
    do {
      const page = await listInbox(env.INBOX_DB, { ...q(now, u), cursor, limit: 7 });
      seen.push(...page.items.map((i) => i.title));
      cursor = page.nextCursor
        ? JSON.parse(atob(page.nextCursor.replaceAll("-", "+").replaceAll("_", "/")))
        : null;
    } while (cursor);
    expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => `i${i}`));
  });

  it("ignores ids of weeks outside the TTL instead of making tables for them", async () => {
    const now = base();
    const forged = (bucketOf(now) + 500) * 2 ** 32 + 7;
    await markRead(env.INBOX_DB, uid(), [forged], now, TTL);
    expect(await deleteItem(env.INBOX_DB, uid(), forged, now, TTL)).toBe(false);
    expect(await tableExists(bucketTable(bucketOf(now) + 500))).toBe(false);
  });

  it("drops a week once all of it is past the TTL, writing no rows, and keeps newer weeks", async () => {
    const now = base();
    const [old, recent] = [uid(), uid()];
    await insertPersonal(env.INBOX_DB, [old], p("old"), now - (TTL + 10) * DAY);
    await insertPersonal(env.INBOX_DB, [recent], p("recent"), now - DAY);
    const oldTable = bucketTable(bucketOf(now - (TTL + 10) * DAY));
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { dropped } = await metered(env, true, { via: "test" }, (e) =>
      dropExpiredBuckets(e.INBOX_DB, now - TTL * DAY),
    );
    expect(dropped).toBeGreaterThanOrEqual(1);
    expect(await tableExists(oldTable)).toBe(false);
    expect(await tableExists(bucketTable(bucketOf(now - DAY)))).toBe(true);
    expect((await inboxRows("user_id = ?", recent)).length).toBe(1);
    const logged = info.mock.calls[0]?.[0] as
      | { queries: Record<string, { rowsWritten: number }> }
      | undefined;
    const queries = logged?.queries ?? {};
    const drops = Object.entries(queries).filter(([name]) => name.startsWith("other:drop"));
    expect(drops.length).toBeGreaterThan(0);
    expect(drops.every(([, t]) => t.rowsWritten === 0)).toBe(true);
  });

  it("is made ahead by the cleanup cron, which also drops expired weeks", async () => {
    const now = base();
    const u = uid();
    await insertPersonal(env.INBOX_DB, [u], p("expired"), now - (TTL + 14) * DAY);
    const report = await runCleanup({ ...env, INBOX_TTL_DAYS: String(TTL) }, now);
    expect(report.inboxWeeks).toBeGreaterThanOrEqual(1);
    expect(await tableExists(bucketTable(bucketOf(now)))).toBe(true);
    expect(await tableExists(bucketTable(bucketOf(now + BUCKET_MS)))).toBe(true);
    expect((await inboxRows("user_id = ?", u)).length).toBe(0);
  });

  it("deletes an unverified sign-up's items from every week", async () => {
    const now = Date.now();
    const id = await seedUser(now - 30 * DAY, "-unverified-weeks");
    await env.DB.prepare("UPDATE user SET emailVerified = 0 WHERE id = ?").bind(id).run();
    await insertPersonal(env.INBOX_DB, [id], p("a"), now - 8 * DAY);
    await insertPersonal(env.INBOX_DB, [id], p("b"), now - DAY);
    expect((await inboxRows("user_id = ?", id)).length).toBe(2);
    await runCleanup(env, now);
    expect((await inboxRows("user_id = ?", id)).length).toBe(0);
  });

  it("keeps week 0's ids out of the legacy range", () => {
    expect(bucketOfId(2 ** 32)).toBe(0);
    expect(bucketOfId(2 ** 32 - 1)).toBeNull();
    expect(bucketOfId(3 * 2 ** 32 + 5)).toBe(2);
  });

  it("stops dropping weeks at the deadline and says so", async () => {
    const now = base();
    await insertPersonal(env.INBOX_DB, [uid()], p("old"), now - (TTL + 10) * DAY);
    const result = await dropExpiredBuckets(env.INBOX_DB, now - TTL * DAY, Date.now() - 1);
    expect(result).toEqual({ dropped: 0, complete: false });
    expect(await tableExists(bucketTable(bucketOf(now - (TTL + 10) * DAY)))).toBe(true);
  });

  it("stores a push's items once when its week has no table yet", async () => {
    const now = base() + 3 * BUCKET_MS; // a week nothing has made
    const u = uid();
    const write = () =>
      writeInboxOnce(
        env.INBOX_DB,
        900_000 + bases,
        [
          env.INBOX_DB.prepare(
            `INSERT INTO ${bucketTable(bucketOf(now))} (user_id, title, body, category, created_at) VALUES (?, 'push', 'b', 'transactional', ?)`,
          ).bind(u, now),
        ],
        now,
      );
    expect(await tableExists(bucketTable(bucketOf(now)))).toBe(false);
    await write();
    await write(); // a retry of the same push stores nothing more
    expect((await inboxRows("user_id = ?", u)).length).toBe(1);
  });

  it("marks read and lists in one batch when this week's table is missing", async () => {
    const now = base() + 5 * BUCKET_MS;
    const u = uid();
    await insertPersonal(env.INBOX_DB, [u], p("last week"), now - 8 * DAY);
    const [first] = (await listInbox(env.INBOX_DB, q(now, u))).items;
    const id = Number(first?.id.slice(2));
    const page = await listInboxWithUnread(
      env.INBOX_DB,
      q(now, u),
      markReadStatements(env.INBOX_DB, u, [id], now, TTL),
    );
    expect(page.items.map((i) => i.read)).toEqual([true]);
    expect(page.unreadCount).toBe(0);
  });

  it("caps INBOX_TTL_DAYS at 90 days and falls back to 30", () => {
    const ttl = (v: string) => inboxTtlDays({ ...env, INBOX_TTL_DAYS: v });
    expect([ttl("14"), ttl("90"), ttl("91"), ttl("0"), ttl("1.5"), ttl("")]).toEqual([
      14, 90, 30, 30, 30, 30,
    ]);
  });
});
