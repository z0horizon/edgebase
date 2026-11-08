import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

const NOW_ISO = "2026-11-08T00:00:00.000Z";
const insertUser = (id: string) =>
  env.DB.prepare(
    "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'A', ?, 1, ?, ?)",
  ).bind(id, `${id}@x.io`, NOW_ISO, NOW_ISO);

it("deleting a user cascades to its devices", async () => {
  await env.DB.batch([
    insertUser("u1"),
    env.DB.prepare("INSERT INTO device VALUES ('t1', 'u1', 'ios', 0)"),
  ]);
  await env.DB.prepare("DELETE FROM user WHERE id = 'u1'").run();
  expect(await env.DB.prepare("SELECT count(*) AS n FROM device").first("n")).toBe(0);
});

it("device rejects an unknown platform", async () => {
  await insertUser("u2").run();
  await expect(
    env.DB.prepare("INSERT INTO device VALUES ('t2', 'u2', 'blackberry', 0)").run(),
  ).rejects.toThrow(/CHECK constraint/);
});

it("user.marketingOptIn defaults to off", async () => {
  await insertUser("u3").run();
  expect(
    await env.DB.prepare("SELECT marketingOptIn FROM user WHERE id = 'u3'").first("marketingOptIn"),
  ).toBe(0);
});

it("inbox tables exist in INBOX_DB", async () => {
  const names = await env.INBOX_DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('inbox_item', 'broadcast', 'inbox_state') ORDER BY name",
  ).all<{ name: string }>();
  expect(names.results.map((r) => r.name)).toEqual(["broadcast", "inbox_item", "inbox_state"]);
});
