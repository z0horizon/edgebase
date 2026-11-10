import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { runCleanup } from "../src/jobs/cleanup";
import { CLAIM_MS, deliverStored, enqueueDuePushes } from "../src/jobs/scheduled";
import { fakeQueue, seedUser, signUpVerified } from "./helpers";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 8);
const iso = (ms: number) => new Date(ms).toISOString();
/** `n` inbox rows for `userId`, all stamped `createdAt`. */
const seedInbox = (userId: string, n: number, createdAt: number) =>
  env.INBOX_DB.prepare(
    `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < ?)
     INSERT INTO inbox_item (user_id, title, body, category, created_at)
     SELECT ?, 't', 'b', 'transactional', ? FROM n`,
  )
    .bind(n, userId, createdAt)
    .run();
const count = (db: D1Database, sql: string, ...params: unknown[]) =>
  db
    .prepare(sql)
    .bind(...params)
    .first<number>("n");

describe("runCleanup", () => {
  it("removes all 5001 expired inbox rows and keeps fresh ones", async () => {
    await seedInbox("old", 5001, NOW - 31 * DAY);
    for (let i = 0; i < 3; i++) {
      await env.INBOX_DB.prepare(
        "INSERT INTO inbox_item (user_id, title, body, category, created_at) VALUES ('fresh', 't', 'b', 'transactional', ?)",
      )
        .bind(NOW - DAY)
        .run();
    }
    const report = await runCleanup(env, NOW);
    expect(report.inbox).toBe(5001);
    expect(await count(env.INBOX_DB, "SELECT count(*) AS n FROM inbox_item")).toBe(3);
    expect(report.inboxBytes).toBeGreaterThan(0);
    expect(report.dbBytes).toBeGreaterThan(0);
  });

  it("removes expired broadcasts, sessions, verifications and stale devices; keeps live ones", async () => {
    const u = await seedUser();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId) VALUES ('s-old', ?, 'tok-old', ?, ?, ?), ('s-live', ?, 'tok-live', ?, ?, ?)",
      ).bind(
        iso(NOW - 1),
        iso(NOW - DAY),
        iso(NOW - DAY),
        u,
        iso(NOW + DAY),
        iso(NOW),
        iso(NOW),
        u,
      ),
      env.DB.prepare(
        "INSERT INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt) VALUES ('v-old', 'i', 'v', ?, ?, ?), ('v-live', 'i', 'v', ?, ?, ?)",
      ).bind(iso(NOW - 1), iso(NOW), iso(NOW), iso(NOW + DAY), iso(NOW), iso(NOW)),
      env.DB.prepare(
        "INSERT INTO device VALUES ('d-stale', ?, 'ios', ?), ('d-live', ?, 'ios', ?)",
      ).bind(u, NOW - 61 * DAY, u, NOW - 59 * DAY),
    ]);
    await env.INBOX_DB.prepare(
      "INSERT INTO broadcast (title, body, category, created_at) VALUES ('old', 'b', 'marketing', ?), ('new', 'b', 'marketing', ?)",
    )
      .bind(NOW - 31 * DAY, NOW - DAY)
      .run();

    const report = await runCleanup(env, NOW);
    expect(report).toMatchObject({ session: 1, verification: 1, device: 1, broadcast: 1 });
    expect(await count(env.DB, "SELECT count(*) AS n FROM session WHERE id = 's-live'")).toBe(1);
    expect(await count(env.DB, "SELECT count(*) AS n FROM verification WHERE id = 'v-live'")).toBe(
      1,
    );
    expect(await count(env.DB, "SELECT count(*) AS n FROM device WHERE token = 'd-live'")).toBe(1);
    expect(
      await count(env.INBOX_DB, "SELECT count(*) AS n FROM broadcast WHERE title = 'new'"),
    ).toBe(1);
  });
});

it("removes expired invitations, idempotency keys and 90-day-old push stats with their opens", async () => {
  const u = await seedUser();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES ('o1', 'O', 'o-clean', ?)",
    ).bind(iso(NOW)),
    env.DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m1', 'o1', ?, 'owner', ?)",
    ).bind(u, iso(NOW)),
    env.DB.prepare(
      `INSERT INTO invitation (id, organizationId, email, status, expiresAt, createdAt, inviterId)
       VALUES ('i-old', 'o1', 'a@x.io', 'pending', ?1, ?1, ?3), ('i-live', 'o1', 'b@x.io', 'pending', ?2, ?2, ?3)`,
    ).bind(iso(NOW - 1), iso(NOW + DAY), u),
    env.DB.prepare(
      "INSERT INTO push_idempotency VALUES ('k-old', 'h', '{}', ?), ('k-live', 'h', '{}', ?)",
    ).bind(NOW - DAY - 1, NOW - 1),
    env.DB.prepare(
      "INSERT INTO push_stats (id, category, send_at) VALUES (9001, 'transactional', ?), (9002, 'transactional', ?)",
    ).bind(NOW - 91 * DAY, NOW - 89 * DAY),
    env.DB.prepare("INSERT INTO push_open VALUES (9001, ?), (9002, ?)").bind(u, u),
  ]);
  const report = await runCleanup(env, NOW);
  expect(report).toMatchObject({ invitation: 1, idempotency: 1, pushOpen: 1, pushStats: 1 });
  expect(await count(env.DB, "SELECT count(*) AS n FROM invitation WHERE id = 'i-live'")).toBe(1);
  expect(
    await count(env.DB, "SELECT count(*) AS n FROM push_idempotency WHERE key = 'k-live'"),
  ).toBe(1);
  expect(await count(env.DB, "SELECT count(*) AS n FROM push_stats WHERE id = 9002")).toBe(1);
  expect(await count(env.DB, "SELECT count(*) AS n FROM push_open WHERE push_id = 9002")).toBe(1);
});

describe("runCleanup bounds", () => {
  it("does not scan fresh rows when nothing has expired", async () => {
    await seedInbox("fresh-many", 2000, NOW);
    const u = await seedUser();
    await env.DB.prepare(
      `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 2000)
       INSERT INTO device (token, user_id, platform, updated_at) SELECT 'fresh-' || x, ?, 'ios', ? FROM n`,
    )
      .bind(u, NOW)
      .run();
    const report = await runCleanup(env, NOW);
    expect(report.inbox + report.device).toBe(0);
    expect(report.rowsRead).toBeLessThan(200);
  });

  it("reports an incomplete run when the time budget runs out", async () => {
    await seedInbox("old-2", 5001, NOW - 40 * DAY);
    // Far enough ahead that every inbox row in this file has expired: well over one chunk.
    const later = NOW + 100 * DAY;
    const report = await runCleanup(env, later, 0);
    expect(report.complete).toBe(false);
    expect(report.inbox).toBe(5000);
    expect((await runCleanup(env, later)).complete).toBe(true);
  });

  it("removes week-old unverified email sign-ups but keeps verified and social users", async () => {
    const user = (id: string, verified: number, createdAt: number) =>
      env.DB.prepare(
        "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(id, id, `${id}@x.io`, verified, iso(createdAt), iso(createdAt));
    const account = (userId: string, provider: string) =>
      env.DB.prepare(
        "INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(`${userId}-${provider}`, userId, provider, userId, iso(NOW), iso(NOW));
    await env.DB.batch([
      user("stale-unverified", 0, NOW - 8 * DAY),
      account("stale-unverified", "credential"),
      user("recent-unverified", 0, NOW - 6 * DAY),
      account("recent-unverified", "credential"),
      user("old-verified", 1, NOW - 30 * DAY),
      account("old-verified", "credential"),
      user("github-unverified", 0, NOW - 30 * DAY),
      account("github-unverified", "github"),
    ]);
    const report = await runCleanup(env, NOW);
    expect(report.unverifiedUsers).toBe(1);
    const left = await env.DB.prepare(
      "SELECT id FROM user WHERE id IN ('stale-unverified', 'recent-unverified', 'old-verified', 'github-unverified') ORDER BY id",
    ).all<{ id: string }>();
    expect(left.results.map((r) => r.id)).toEqual([
      "github-unverified",
      "old-verified",
      "recent-unverified",
    ]);
  });
});

describe("enqueueDuePushes", () => {
  const request = (topic: string) =>
    JSON.stringify({ to: { topic }, title: "t", body: "b", category: "transactional" });

  it("dispatches and deletes due rows; future rows stay", async () => {
    await env.DB.prepare("INSERT INTO scheduled_push (send_at, request) VALUES (?, ?), (?, ?)")
      .bind(NOW - 1, request("due"), NOW + 60_000, request("later"))
      .run();
    const q = fakeQueue();
    expect(await enqueueDuePushes({ ...env, PUSH_QUEUE: q.queue }, NOW)).toBe(1);
    expect(q.sent.map((s) => (s.body as { topic: string }).topic)).toEqual(["due"]);
    const left = await env.DB.prepare("SELECT request FROM scheduled_push").all<{
      request: string;
    }>();
    expect(left.results.map((r) => JSON.parse(r.request).to.topic)).toEqual(["later"]);
  });

  it("a row with an invalid request is deleted without dispatch", async () => {
    await env.DB.prepare(
      "INSERT INTO scheduled_push (send_at, request) VALUES (?, '{\"to\":1}'), (?, 'not json')",
    )
      .bind(NOW - 2, NOW - 2)
      .run();
    const q = fakeQueue();
    await enqueueDuePushes({ ...env, PUSH_QUEUE: q.queue }, NOW);
    expect(q.sent).toEqual([]);
    expect(
      await count(env.DB, "SELECT count(*) AS n FROM scheduled_push WHERE send_at = ?", NOW - 2),
    ).toBe(0);
  });

  it("a dispatch that fails after writing the inbox does not write it again on the next run", async () => {
    const u = await seedUser();
    // The last run below is past every earlier test's rows too.
    await env.DB.prepare("DELETE FROM scheduled_push").run();
    await env.DB.prepare("INSERT INTO scheduled_push (send_at, request) VALUES (?, ?)")
      .bind(
        NOW - 3,
        JSON.stringify({
          to: { userIds: [u] },
          title: "t",
          body: "b",
          category: "transactional",
          inbox: true,
        }),
      )
      .run();
    const broken = fakeQueue();
    broken.queue.sendBatch = async () => {
      throw new Error("queue unavailable");
    };
    expect(await enqueueDuePushes({ ...env, PUSH_QUEUE: broken.queue }, NOW)).toBe(0);
    const early = fakeQueue();
    expect(await enqueueDuePushes({ ...env, PUSH_QUEUE: early.queue }, NOW)).toBe(0);
    expect(early.sent).toEqual([]);
    const q = fakeQueue();
    const afterClaim = Date.now() + CLAIM_MS + 1000;
    expect(await enqueueDuePushes({ ...env, PUSH_QUEUE: q.queue }, afterClaim)).toBe(1);
    expect(q.sent).toHaveLength(1);
    expect(
      await count(env.INBOX_DB, "SELECT count(*) AS n FROM inbox_item WHERE user_id = ?", u),
    ).toBe(1);
  });
});

describe("scheduled push claims", () => {
  const topicRequest = {
    to: { topic: "claims" },
    title: "t",
    body: "b",
    category: "transactional",
  } as const;
  const store = async (sendAt: number) =>
    (await env.DB.prepare(
      "INSERT INTO scheduled_push (send_at, request, push_id) VALUES (?, ?, 0) RETURNING id",
    )
      .bind(sendAt, JSON.stringify(topicRequest))
      .first<number>("id")) as number;

  it("a run whose claim was taken over queues nothing; the new holder sends once", async () => {
    const stale = NOW - 10;
    const id = await store(stale);
    const takeover = fakeQueue();
    expect(await enqueueDuePushes({ ...env, PUSH_QUEUE: takeover.queue }, NOW)).toBeGreaterThan(0);
    const late = fakeQueue();
    const result = await deliverStored(
      { ...env, PUSH_QUEUE: late.queue },
      { id, request: topicRequest, pushId: 0, claimed: stale },
      NOW,
    );
    expect(result).toBeNull();
    expect(late.sent).toEqual([]);
    expect(
      takeover.sent.filter((s) => (s.body as { topic: string }).topic === "claims"),
    ).toHaveLength(1);
  });

  it("a row that keeps failing does not hold back the rows behind it", async () => {
    await env.DB.prepare("INSERT INTO scheduled_push (send_at, request, push_id) VALUES (?, ?, 0)")
      .bind(NOW - 5, JSON.stringify({ ...topicRequest, to: { userIds: ["u"] } }))
      .run();
    await store(NOW - 4);
    const q = fakeQueue();
    const send = q.queue.sendBatch.bind(q.queue);
    q.queue.sendBatch = async (messages) => {
      if ([...messages].some((m) => (m.body as { kind: string }).kind === "users")) {
        throw new Error("queue unavailable");
      }
      return send(messages);
    };
    expect(await enqueueDuePushes({ ...env, PUSH_QUEUE: q.queue }, NOW)).toBeGreaterThan(0);
    expect(q.sent.map((s) => (s.body as { topic: string }).topic)).toContain("claims");
  });
});

it("cleanup removes a session Better Auth itself wrote, once it has expired", async () => {
  const { userId } = await signUpVerified("cleanup-real@x.io");
  const row = await env.DB.prepare("SELECT expiresAt FROM session WHERE userId = ?")
    .bind(userId)
    .first<{ expiresAt: string }>();
  expect(row?.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  await runCleanup(env, Date.parse(row?.expiresAt ?? "") - 1);
  expect(await count(env.DB, "SELECT count(*) AS n FROM session WHERE userId = ?", userId)).toBe(1);
  await runCleanup(env, Date.parse(row?.expiresAt ?? "") + 1);
  expect(await count(env.DB, "SELECT count(*) AS n FROM session WHERE userId = ?", userId)).toBe(0);
});
