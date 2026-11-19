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

it("an Idempotency-Key replays the first answer per user instead of running the batch again", async () => {
  const a = await signUpVerified("batch-idem-a@example.com");
  const b = await signUpVerified("batch-idem-b@example.com");
  const item = { title: "t", body: "b", category: "transactional" as const };
  const count = [{ method: "GET", path: "/v1/inbox/unread-count" }];
  const keyed = (token: string, requests: unknown, key = "retry-1") =>
    call("/v1/batch", authed(token, json({ requests }, { headers: { "idempotency-key": key } })));

  const first = await keyed(a.token, count);
  expect(first.headers.get("idempotent-replayed")).toBeNull();
  expect(await first.json()).toEqual({ responses: [{ status: 200, body: { count: 0 } }] });

  // The retry answers what the first run answered, though the inbox has changed since.
  await insertPersonal(env.INBOX_DB, [a.userId, b.userId], item, Date.now() - 1000);
  const replay = await keyed(a.token, count);
  expect(replay.status).toBe(200);
  expect(replay.headers.get("idempotent-replayed")).toBe("true");
  expect(await replay.json()).toEqual({ responses: [{ status: 200, body: { count: 0 } }] });

  // Another user's same key is their own; another body under the key is refused.
  expect(await (await keyed(b.token, count)).json()).toEqual({
    responses: [{ status: 200, body: { count: 1 } }],
  });
  const other = await keyed(a.token, [{ method: "GET", path: "/v1/me" }]);
  expect(other.status).toBe(422);
  expect(await other.json()).toMatchObject({ error: { code: "idempotency_mismatch" } });
  expect((await keyed(a.token, count, "bad key")).status).toBe(400);
  // An invalid batch frees its key for the corrected request.
  expect((await keyed(a.token, [{ method: "GET", path: "/nope" }], "retry-2")).status).toBe(400);
  expect((await keyed(a.token, count, "retry-2")).status).toBe(200);
});

it("a replay of an answer over 64 KB keeps each status without the bodies", async () => {
  const { userId, token } = await signUpVerified("batch-idem-big@example.com");
  const now = Date.now();
  for (let i = 0; i < 100; i++) {
    await insertPersonal(
      env.INBOX_DB,
      [userId],
      { title: `t${i}`, body: "x".repeat(500), category: "transactional" },
      now - 1000 - i,
    );
  }
  const requests = [
    { method: "GET", path: "/v1/inbox?limit=100" },
    { method: "GET", path: "/v1/inbox?limit=100" },
    { method: "POST", path: "/v1/inbox/read-all" },
  ];
  const send = () =>
    call("/v1/batch", authed(token, json({ requests }, { headers: { "idempotency-key": "big" } })));
  const first = await (await send()).json<BatchBody>();
  expect(JSON.stringify(first).length).toBeGreaterThan(64 * 1024);
  expect(await (await send()).json()).toEqual({
    responses: [
      { status: 200, body: null },
      { status: 200, body: null },
      { status: 204, body: null },
    ],
    truncated: true,
  });
});
