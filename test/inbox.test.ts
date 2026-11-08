import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  insertBroadcast,
  insertPersonal,
  listInbox,
  markAllRead,
  markRead,
  unreadCount,
} from "../src/inbox/queries";
import { authed, call, json, signUpVerified } from "./helpers";

const DAY = 86_400_000;
let epochs = 0;
/** A past time base 1000 days from any other test's: broadcasts are global and storage is shared. */
const epoch = () => Date.UTC(2020, 0, 1) - ++epochs * 1000 * DAY;
const p = (title: string) => ({ title, body: "b", category: "transactional" as const });
let n = 0;
const uid = () => `inbox-user-${++n}`;
const q = (NOW: number, userId: string, extra: Partial<Parameters<typeof listInbox>[1]> = {}) => ({
  userId,
  userCreatedAt: NOW - 100 * DAY,
  cursor: null,
  limit: 20,
  now: NOW,
  ttlDays: 30,
  ...extra,
});

describe("inbox queries", () => {
  it("pages through 45 mixed items with no duplicates or gaps", async () => {
    const NOW = epoch();
    const u = uid();
    for (let i = 0; i < 30; i++)
      await insertPersonal(env.INBOX_DB, [u], p(`p${i}`), NOW - i * 3 * 60_000);
    // Some broadcasts share a timestamp with personal items to exercise the tie-break.
    for (let i = 0; i < 15; i++)
      await insertBroadcast(env.INBOX_DB, p(`b${i}`), NOW - i * 6 * 60_000);
    const seen: string[] = [];
    let cursor = null;
    const pages: number[] = [];
    do {
      const page = await listInbox(env.INBOX_DB, q(NOW, u, { cursor }));
      pages.push(page.items.length);
      seen.push(...page.items.map((it) => it.title));
      const times = page.items.map((it) => it.createdAt);
      expect(times).toEqual([...times].sort((a, b) => b - a));
      cursor = page.nextCursor
        ? JSON.parse(atob(page.nextCursor.replaceAll("-", "+").replaceAll("_", "/")))
        : null;
    } while (cursor);
    expect(pages).toEqual([20, 20, 5]);
    expect(new Set(seen).size).toBe(45);
  });

  it("a broadcast is shown to users created before it, not after", async () => {
    const NOW = epoch();
    await insertBroadcast(env.INBOX_DB, p("launch"), NOW - DAY);
    const older = await listInbox(env.INBOX_DB, q(NOW, uid(), { userCreatedAt: NOW - 2 * DAY }));
    const newer = await listInbox(env.INBOX_DB, q(NOW, uid(), { userCreatedAt: NOW - DAY / 2 }));
    expect(older.items.map((i) => i.title)).toContain("launch");
    expect(newer.items.map((i) => i.title)).not.toContain("launch");
  });

  it("read-all brings unread-count to 0 and later items count again", async () => {
    const NOW = epoch();
    const u = uid();
    const base = q(NOW, u, { userCreatedAt: NOW - DAY / 4 });
    await insertPersonal(env.INBOX_DB, [u], p("one"), NOW - 2000);
    await insertBroadcast(env.INBOX_DB, p("all"), NOW - 1000);
    expect(await unreadCount(env.INBOX_DB, base)).toBe(2);
    await markAllRead(env.INBOX_DB, u, NOW);
    expect(await unreadCount(env.INBOX_DB, base)).toBe(0);
    expect((await listInbox(env.INBOX_DB, base)).items.every((i) => i.read)).toBe(true);
    await insertPersonal(env.INBOX_DB, [u], p("two"), NOW + 1000);
    expect(await unreadCount(env.INBOX_DB, { ...base, now: NOW + 2000 })).toBe(1);
  });

  it("markRead marks only the caller's personal items", async () => {
    const NOW = epoch();
    const [a, b] = [uid(), uid()];
    await insertPersonal(env.INBOX_DB, [a, b], p("x"), NOW - 1000);
    const ids = (
      await env.INBOX_DB.prepare(
        "SELECT id FROM inbox_item WHERE title = 'x' AND user_id IN (?, ?)",
      )
        .bind(a, b)
        .all<{ id: number }>()
    ).results.map((r) => r.id);
    await markRead(env.INBOX_DB, a, ids, NOW);
    const recent = { userCreatedAt: NOW - 1 };
    expect(await unreadCount(env.INBOX_DB, q(NOW, a, recent))).toBe(0);
    expect(await unreadCount(env.INBOX_DB, q(NOW, b, recent))).toBe(1);
  });

  it("items older than the TTL are neither listed nor counted", async () => {
    const NOW = epoch();
    const u = uid();
    await insertPersonal(env.INBOX_DB, [u], p("old"), NOW - 31 * DAY);
    await insertPersonal(env.INBOX_DB, [u], p("new"), NOW - DAY);
    const base = q(NOW, u, { userCreatedAt: NOW - 1 });
    expect((await listInbox(env.INBOX_DB, base)).items.map((i) => i.title)).toEqual(["new"]);
    expect(await unreadCount(env.INBOX_DB, base)).toBe(1);
  });
});

describe("inbox routes", () => {
  it.each(["garbage", btoa('{"t":"x"}')])(
    "cursor %s answers 400 invalid_cursor",
    async (cursor) => {
      const { token } = await signUpVerified(`cur-${cursor.length}@x.io`);
      const res = await call(`/v1/inbox?cursor=${encodeURIComponent(cursor)}`, authed(token));
      expect(res.status).toBe(400);
      expect((await res.json<{ error: { code: string } }>()).error.code).toBe("invalid_cursor");
    },
  );

  it.each([
    ["0", 1],
    ["500", 100],
    ["abc", 20],
  ])("limit=%s returns at most %i items", async (limit, expected) => {
    const { userId, token } = await signUpVerified(`lim-${limit}@x.io`);
    await insertPersonal(env.INBOX_DB, Array(120).fill(userId), p("same"), Date.now());
    const res = await call(`/v1/inbox?limit=${limit}`, authed(token));
    expect((await res.json<{ items: unknown[] }>()).items).toHaveLength(expected);
  });

  it("read, read-all, unread-count and delete work over HTTP for the caller only", async () => {
    const a = await signUpVerified("http-a@x.io");
    const b = await signUpVerified("http-b@x.io");
    const now = Date.now();
    await insertPersonal(env.INBOX_DB, [a.userId], p("mine"), now);
    const list = await (await call("/v1/inbox", authed(a.token))).json<{
      items: { id: string }[];
    }>();
    const id = list.items[0]?.id ?? "";
    expect(id).toMatch(/^p_\d+$/);
    expect((await call(`/v1/inbox/${id}`, authed(b.token, { method: "DELETE" }))).status).toBe(404);
    expect(
      (await call("/v1/inbox/read", authed(a.token, json({ ids: [id, "b_1", "junk"] })))).status,
    ).toBe(204);
    expect(await (await call("/v1/inbox/unread-count", authed(a.token))).json()).toEqual({
      count: 0,
    });
    expect((await call("/v1/inbox/read-all", authed(a.token, json({})))).status).toBe(204);
    expect((await call(`/v1/inbox/${id}`, authed(a.token, { method: "DELETE" }))).status).toBe(204);
    expect((await call(`/v1/inbox/${id}`, authed(a.token, { method: "DELETE" }))).status).toBe(404);
  });
});

it("POST /v1/inbox/read accepts the documented maximum of 100 ids", async () => {
  const { token } = await signUpVerified("read-100@x.io");
  const ids = Array.from({ length: 100 }, (_, i) => `p_${i + 1}`);
  const res = await call("/v1/inbox/read", authed(token, json({ ids })));
  expect(res.status).toBe(204);
});
