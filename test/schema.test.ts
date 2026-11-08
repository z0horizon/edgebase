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

it("user.marketingOptIn defaults to off", async () => {
  const id = await seedUser();
  expect(
    await env.DB.prepare("SELECT marketingOptIn FROM user WHERE id = ?")
      .bind(id)
      .first("marketingOptIn"),
  ).toBe(0);
});
