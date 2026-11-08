import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { upsertDevice } from "../src/push/devices";
import { authed, call, json, seedUser, signUpVerified } from "./helpers";

const DAY = 86_400_000;
const DAY0 = Date.UTC(2026, 10, 1);
const owner = (token: string) =>
  env.DB.prepare("SELECT user_id FROM device WHERE token = ?").bind(token).first<string>("user_id");

describe("upsertDevice", () => {
  it("re-registering within 7 days writes nothing", async () => {
    const d = { token: "t", userId: await seedUser(), platform: "ios" } as const;
    expect((await upsertDevice(env.DB, d, DAY0)).written).toBe(true);
    expect((await upsertDevice(env.DB, d, DAY0 + 6 * DAY)).written).toBe(false);
    expect((await upsertDevice(env.DB, d, DAY0 + 7 * DAY)).written).toBe(true);
  });

  it("a token registered by another user moves to that user", async () => {
    const [u1, u2] = [await seedUser(), await seedUser()];
    await upsertDevice(env.DB, { token: "shared", userId: u1, platform: "android" }, DAY0);
    expect(
      (await upsertDevice(env.DB, { token: "shared", userId: u2, platform: "android" }, DAY0 + 1))
        .written,
    ).toBe(true);
    expect(await owner("shared")).toBe(u2);
  });

  it("the 11th device evicts the oldest", async () => {
    const u = await seedUser();
    for (let i = 0; i <= 10; i++) {
      await upsertDevice(env.DB, { token: `t${i}`, userId: u, platform: "ios" }, DAY0 + i);
    }
    const rows = await env.DB.prepare("SELECT token FROM device WHERE user_id = ?").bind(u).all();
    expect(rows.results).toHaveLength(10);
    expect(await owner("t0")).toBeNull();
  });
});

describe("device routes", () => {
  it("PUT /v1/devices registers the caller's token", async () => {
    const { userId, token } = await signUpVerified("dev1@x.io");
    const res = await call(
      "/v1/devices",
      authed(token, json({ token: "fcm-1", platform: "web" }, { method: "PUT" })),
    );
    expect(res.status).toBe(204);
    expect(await owner("fcm-1")).toBe(userId);
  });

  it.each([
    ["unknown platform", { token: "x", platform: "blackberry" }],
    ["empty token", { token: "", platform: "ios" }],
    ["token over 4096 chars", { token: "x".repeat(4097), platform: "ios" }],
  ])("PUT /v1/devices with %s answers 400", async (_name, body) => {
    const { token } = await signUpVerified(`bad-${_name.length}@x.io`);
    const res = await call("/v1/devices", authed(token, json(body, { method: "PUT" })));
    expect(res.status).toBe(400);
  });

  it("DELETE /v1/devices/:token does not touch another user's token", async () => {
    const a = await signUpVerified("dev2@x.io");
    const b = await signUpVerified("dev3@x.io");
    await call(
      "/v1/devices",
      authed(a.token, json({ token: "fcm-a", platform: "ios" }, { method: "PUT" })),
    );
    expect((await call("/v1/devices/fcm-a", authed(b.token, { method: "DELETE" }))).status).toBe(
      204,
    );
    expect(await owner("fcm-a")).toBe(a.userId);
    await call("/v1/devices/fcm-a", authed(a.token, { method: "DELETE" }));
    expect(await owner("fcm-a")).toBeNull();
  });
});
