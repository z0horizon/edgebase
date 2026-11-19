import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { insertPersonal } from "../src/inbox/queries";
import { authed, call, json, signUpVerified } from "./helpers";

type BatchBody = { responses: { status: number; body: unknown }[] };
const batch = (token: string, requests: unknown) =>
  call("/v1/batch", authed(token, json({ requests })));

it("POST /v1/batch runs /v1 calls in order as the caller and answers each one", async () => {
  const { userId, token } = await signUpVerified("batch-ok@example.com");
  await insertPersonal(
    env.INBOX_DB,
    [userId],
    { title: "hello", body: "b", category: "transactional" },
    Date.now() - 1000,
  );
  const res = await batch(token, [
    { method: "GET", path: "/v1/inbox/unread-count" },
    { method: "POST", path: "/v1/inbox/read-all" },
    { method: "GET", path: "/v1/inbox/unread-count" },
    { method: "PUT", path: "/v1/devices", body: { token: "batch-fcm", platform: "android" } },
    { method: "PUT", path: "/v1/devices", body: { token: "x", platform: "windows" } },
    { method: "GET", path: "/v1/me?unused=1" },
    { method: "GET", path: "/v1/no-such-route" },
  ]);
  expect(res.status).toBe(200);
  const { responses } = await res.json<BatchBody>();
  expect(responses.map((r) => r.status)).toEqual([200, 204, 200, 204, 400, 200, 404]);
  expect(responses[0]?.body).toEqual({ count: 1 });
  expect(responses[1]?.body).toBeNull();
  expect(responses[2]?.body).toEqual({ count: 0 });
  expect(responses[4]?.body).toMatchObject({ error: { code: expect.any(String) } });
  expect(responses[5]?.body).toMatchObject({ id: userId });
  expect(responses[6]?.body).toEqual({ error: { code: "not_found", message: "Route not found" } });
  expect(
    await env.DB.prepare("SELECT user_id FROM device WHERE token = 'batch-fcm'").first("user_id"),
  ).toBe(userId);
});

it("POST /v1/batch refuses anything but 1 to 10 /v1 routes, nested batches and callers without a session", async () => {
  const { token } = await signUpVerified("batch-bad@example.com");
  const me = { method: "GET", path: "/v1/me" };
  for (const requests of [
    [],
    Array.from({ length: 11 }, () => me),
    [{ method: "PATCH", path: "/v1/me" }],
    [me, { method: "POST", path: "/v1/batch", body: { requests: [me] } }],
    [{ method: "POST", path: "/v1/Batch/" }],
    [{ method: "GET", path: "/v1/../api/auth/get-session" }],
    [{ method: "GET", path: "/api/auth/get-session" }],
    [{ method: "GET", path: "//evil.test/v1/me" }],
    [{ method: "GET", path: "https://evil.test/v1/me" }],
  ]) {
    const res = await batch(token, requests);
    expect(res.status, JSON.stringify(requests)).toBe(400);
  }
  expect((await call("/v1/batch", json({ requests: [me] }))).status).toBe(401);
});

it("each call in a batch counts against the per-user limit", async () => {
  const { token } = await signUpVerified("batch-limit@example.com");
  const writes = Array.from({ length: 10 }, () => ({ method: "POST", path: "/v1/inbox/read-all" }));
  const statuses: number[] = [];
  // 60 writing calls a minute: 13 batches hold 130 plus their own 13, past twice the limit.
  for (let i = 0; i < 13 && !statuses.includes(429); i++) {
    const res = await batch(token, writes);
    if (res.status === 429) statuses.push(429);
    else statuses.push(...(await res.json<BatchBody>()).responses.map((r) => r.status));
  }
  expect(statuses).toContain(429);
  expect(statuses.indexOf(429)).toBeGreaterThan(40);
}, 30_000);
