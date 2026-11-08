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
