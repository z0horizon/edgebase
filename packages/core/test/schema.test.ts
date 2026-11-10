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
