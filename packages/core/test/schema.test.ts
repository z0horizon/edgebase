import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedUser } from "./helpers";

it("deleting a user cascades to its devices", async () => {
  const id = await seedUser();
  await env.DB.prepare("INSERT INTO device VALUES ('t1', ?, 'ios', 0)").bind(id).run();
  await env.DB.prepare("DELETE FROM user WHERE id = ?").bind(id).run();
  expect(await env.DB.prepare("SELECT count(*) AS n FROM device").first("n")).toBe(0);
});

it("device rejects an unknown platform", async () => {
  const id = await seedUser();
  await expect(
    env.DB.prepare("INSERT INTO device VALUES ('t2', ?, 'blackberry', 0)").bind(id).run(),
  ).rejects.toThrow(/CHECK constraint/);
});

it("inbox reads find broadcasts by created_at without scanning the table", async () => {
  const plan = await env.INBOX_DB.prepare(
    `EXPLAIN QUERY PLAN SELECT id FROM broadcast WHERE created_at BETWEEN ? AND ?
     ORDER BY created_at DESC, id DESC LIMIT 21`,
  )
    .bind(0, 1)
    .all<{ detail: string }>();
  const details = plan.results.map((r) => r.detail).join("\n");
  expect(details).toMatch(/USING (COVERING )?INDEX broadcast_created_at/);
  expect(details).not.toMatch(/TEMP B-TREE/);
});

it("user.marketingOptIn defaults to off", async () => {
  const id = await seedUser();
  expect(
    await env.DB.prepare("SELECT marketingOptIn FROM user WHERE id = ?")
      .bind(id)
      .first("marketingOptIn"),
  ).toBe(0);
});

it("deleting a user cascades to its trusted devices", async () => {
  const id = await seedUser();
  await env.DB.prepare(
    `INSERT INTO trusted_device (id, token_hash, user_id, created_at, last_used_at, expires_at)
     VALUES ('td1', 'hash1', ?, 1, 1, 2)`,
  )
    .bind(id)
    .run();
  await env.DB.prepare("DELETE FROM user WHERE id = ?").bind(id).run();
  expect(await env.DB.prepare("SELECT count(*) AS n FROM trusted_device").first("n")).toBe(0);
});

it("session.twoFactorMethod rejects an unknown method", async () => {
  const id = await seedUser();
  const now = new Date().toISOString();
  await expect(
    env.DB.prepare(
      `INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId, twoFactorMethod)
       VALUES ('s-bad-2fa', ?, 'tok-bad-2fa', ?, ?, ?, 'sms')`,
    )
      .bind(now, now, now, id)
      .run(),
  ).rejects.toThrow(/CHECK constraint/);
});

it("cleanup finds expired trusted devices via trusted_device_expires_at without scanning", async () => {
  const plan = await env.DB.prepare(
    "EXPLAIN QUERY PLAN SELECT id FROM trusted_device WHERE expires_at < ? LIMIT 5000",
  )
    .bind(1)
    .all<{ detail: string }>();
  const details = plan.results.map((r) => r.detail).join("\n");
  expect(details).toMatch(/USING (COVERING )?INDEX trusted_device_expires_at/);
});

it("trust-device verification prefix delete uses verification_identifier index instead of scanning", async () => {
  const plan = await env.DB.prepare(
    "EXPLAIN QUERY PLAN DELETE FROM verification WHERE identifier GLOB 'trust-device-*' AND value = ?",
  )
    .bind("u1")
    .all<{ detail: string }>();
  const details = plan.results.map((r) => r.detail).join("\n");
  expect(details).toMatch(/USING INDEX verification_identifier/);
  expect(details).not.toMatch(/SCAN verification/);
});

it("twoFactor enforces at most one row per user", async () => {
  const id = await seedUser();
  await env.DB.prepare(
    "INSERT INTO twoFactor (id, secret, backupCodes, userId) VALUES ('tf1', 's', '[]', ?)",
  )
    .bind(id)
    .run();
  await expect(
    env.DB.prepare(
      "INSERT INTO twoFactor (id, secret, backupCodes, userId) VALUES ('tf2', 's', '[]', ?)",
    )
      .bind(id)
      .run(),
  ).rejects.toThrow(/UNIQUE constraint/);
});
