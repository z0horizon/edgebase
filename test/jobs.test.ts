import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { runCleanup } from "../src/jobs/cleanup";
import { enqueueDuePushes } from "../src/jobs/scheduled";
import { fakeQueue, seedUser } from "./helpers";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 8);
const count = (db: D1Database, sql: string, ...params: unknown[]) =>
  db
    .prepare(sql)
    .bind(...params)
    .first<number>("n");

describe("runCleanup", () => {
  it("removes all 5001 expired inbox rows and keeps fresh ones", async () => {
    await env.INBOX_DB.prepare(
      `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 5001)
       INSERT INTO inbox_item (user_id, title, body, category, created_at)
       SELECT 'old', 't', 'b', 'transactional', ? FROM n`,
    )
      .bind(NOW - 31 * DAY)
      .run();
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
    const iso = (ms: number) => new Date(ms).toISOString();
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

describe("runCleanup bounds", () => {
  it("does not scan fresh rows when nothing has expired", async () => {
    await env.INBOX_DB.prepare(
      `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 2000)
       INSERT INTO inbox_item (user_id, title, body, category, created_at)
       SELECT 'fresh-many', 't', 'b', 'transactional', ? FROM n`,
    )
      .bind(NOW)
      .run();
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
    await env.INBOX_DB.prepare(
      `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 5001)
       INSERT INTO inbox_item (user_id, title, body, category, created_at)
       SELECT 'old-2', 't', 'b', 'transactional', ? FROM n`,
    )
      .bind(NOW - 40 * DAY)
      .run();
    // Far enough ahead that every inbox row in this file has expired: well over one chunk.
    const later = NOW + 100 * DAY;
    const report = await runCleanup(env, later, 0);
    expect(report.complete).toBe(false);
    expect(report.inbox).toBe(5000);
    expect((await runCleanup(env, later)).complete).toBe(true);
  });

  it("removes week-old unverified email sign-ups but keeps verified and social users", async () => {
    const iso = (ms: number) => new Date(ms).toISOString();
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
});
