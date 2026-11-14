import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { handlePushBatch } from "../src/push/consumer";
import { resetFcmCacheForTests } from "../src/push/fcm";
import { createPushStats } from "../src/push/stats";
import type { PushQueueMessage } from "../src/push/types";
import { fakeQueue, makeServiceAccount, seedUser } from "./helpers";

let SA = "";
beforeAll(async () => {
  SA = (await makeServiceAccount()).json;
});
afterEach(() => {
  vi.restoreAllMocks();
  resetFcmCacheForTests();
});

const payload = { title: "t", body: "b", category: "transactional" } as const;

/** FCM answers per token from `byToken`; tokens not listed succeed. Returns tokens FCM was asked for. */
function stubFcm(byToken: Record<string, Response> = {}) {
  const asked: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    if (req.url.startsWith("https://oauth2.googleapis.com")) {
      return Response.json({ access_token: "at", expires_in: 3600 });
    }
    const { message } = await req.json<{ message: { token?: string; topic?: string } }>();
    const target = message.token ?? `topic:${message.topic}`;
    asked.push(target);
    return byToken[target]?.clone() ?? Response.json({ name: "m" });
  });
  return asked;
}
const fcmError = (status: number, errorCode: string) =>
  Response.json({ error: { status: errorCode, details: [{ errorCode }] } }, { status });

async function run(body: PushQueueMessage, queue = fakeQueue()) {
  const dlq = fakeQueue();
  const batch = createMessageBatch<PushQueueMessage>("edgebase-push", [
    { id: "m1", timestamp: new Date(), attempts: 1, body },
  ]);
  const ctx = createExecutionContext();
  await handlePushBatch(batch, {
    ...env,
    FCM_SERVICE_ACCOUNT: SA,
    PUSH_QUEUE: queue.queue,
    PUSH_DLQ: dlq.queue,
  });
  return { result: await getQueueResult(batch, ctx), queued: queue.sent, dead: dlq.sent };
}
const addDevice = (token: string, userId: string) =>
  env.DB.prepare("INSERT INTO device VALUES (?, ?, 'ios', 0)").bind(token, userId).run();
const deviceExists = async (token: string) =>
  (await env.DB.prepare("SELECT 1 AS x FROM device WHERE token = ?").bind(token).first("x")) === 1;

describe("handlePushBatch", () => {
  it("sends to every device of the queued users and acks", async () => {
    const u = await seedUser();
    await addDevice("a1", u);
    await addDevice("a2", u);
    const asked = stubFcm();
    const { result } = await run({ kind: "users", userIds: [u], payload, attempt: 0 });
    expect(asked.sort()).toEqual(["a1", "a2"]);
    expect(result.explicitAcks).toEqual(["m1"]);
  });

  it("UNREGISTERED deletes the token", async () => {
    const u = await seedUser();
    await addDevice("gone", u);
    stubFcm({ gone: fcmError(404, "UNREGISTERED") });
    await run({ kind: "users", userIds: [u], payload, attempt: 0 });
    expect(await deviceExists("gone")).toBe(false);
  });

  it("INVALID_ARGUMENT keeps the token and does not retry", async () => {
    const u = await seedUser();
    await addDevice("keep", u);
    stubFcm({ keep: fcmError(400, "INVALID_ARGUMENT") });
    const { queued, dead } = await run({ kind: "users", userIds: [u], payload, attempt: 0 });
    expect(await deviceExists("keep")).toBe(true);
    expect([...queued, ...dead]).toEqual([]);
  });

  it("503 on one of three tokens re-enqueues only that token with a delay", async () => {
    const u = await seedUser();
    for (const t of ["t1", "t2", "t3"]) await addDevice(t, u);
    stubFcm({ t2: fcmError(503, "UNAVAILABLE") });
    const { queued, result } = await run({ kind: "users", userIds: [u], payload, attempt: 0 });
    expect(queued).toEqual([
      {
        body: { kind: "tokens", targets: [{ token: "t2", userId: u }], payload, attempt: 1 },
        delaySeconds: 30,
      },
    ]);
    expect(result.explicitAcks).toEqual(["m1"]);
  });

  it("the fifth failed attempt goes to the DLQ, not the queue", async () => {
    const u = await seedUser();
    await addDevice("t9", u);
    stubFcm({ t9: fcmError(503, "UNAVAILABLE") });
    const targets = [{ token: "t9", userId: u }];
    const { queued, dead } = await run({ kind: "tokens", targets, payload, attempt: 4 });
    expect(queued).toEqual([]);
    expect(dead).toEqual([
      { body: { kind: "tokens", targets, payload, attempt: 5 }, delaySeconds: undefined },
    ]);
  });

  it("a retry skips tokens removed or moved to another user since enqueue", async () => {
    const [a, b] = [await seedUser(), await seedUser()];
    await addDevice("stays", a);
    await addDevice("moved", b);
    const asked = stubFcm();
    const targets = [
      { token: "stays", userId: a },
      { token: "moved", userId: a },
      { token: "removed", userId: a },
    ];
    await run({ kind: "tokens", targets, payload, attempt: 1 });
    expect(asked).toEqual(["stays"]);
  });

  it("marketing pushes skip users who opted out after enqueue or before retry", async () => {
    const [optedIn, optedOut] = [await seedUser(), await seedUser()];
    await env.DB.prepare("UPDATE user SET marketingOptIn = 1 WHERE id = ?").bind(optedIn).run();
    await addDevice("m-in", optedIn);
    await addDevice("m-out", optedOut);
    const marketing = { ...payload, category: "marketing" as const };

    const askedUsers = stubFcm();
    await run({ kind: "users", userIds: [optedIn, optedOut], payload: marketing, attempt: 0 });
    expect(askedUsers).toEqual(["m-in"]);

    const askedRetry = stubFcm();
    const targets = [
      { token: "m-in", userId: optedIn },
      { token: "m-out", userId: optedOut },
    ];
    await run({ kind: "tokens", targets, payload: marketing, attempt: 1 });
    expect(askedRetry).toEqual(["m-in"]);
  });

  it("a topic message is sent once to the topic", async () => {
    const asked = stubFcm();
    await run({ kind: "topic", topic: "all", payload, attempt: 0 });
    expect(asked).toEqual(["topic:all"]);
  });

  it("a user with no devices is acked with no FCM or OAuth call", async () => {
    const u = await seedUser();
    stubFcm();
    const { result } = await run({ kind: "users", userIds: [u], payload, attempt: 0 });
    expect(fetch).not.toHaveBeenCalled();
    expect(result.explicitAcks).toEqual(["m1"]);
  });

  it("a failure after FCM sends is logged and acked, so delivered devices are not sent twice", async () => {
    const u = await seedUser();
    await addDevice("ok-1", u);
    await addDevice("flaky-1", u);
    stubFcm({ "flaky-1": fcmError(503, "UNAVAILABLE") });
    const broken = fakeQueue();
    broken.queue.send = async () => {
      throw new Error("queue unavailable");
    };
    const { result } = await run({ kind: "users", userIds: [u], payload, attempt: 0 }, broken);
    expect(result.explicitAcks).toEqual(["m1"]);
    expect(result.retryMessages).toEqual([]);
  });

  it("counts accepted tokens as sent and refused or out-of-retries ones as failed", async () => {
    const u = await seedUser();
    for (const t of ["s-ok", "s-dead", "s-bad"]) await addDevice(t, u);
    const pushId = await createPushStats(env.DB, "transactional", Date.now());
    const withId = { ...payload, data: { pushId: String(pushId) } };
    stubFcm({
      "s-dead": fcmError(404, "UNREGISTERED"),
      "s-bad": fcmError(400, "INVALID_ARGUMENT"),
    });
    await run({ kind: "users", userIds: [u], payload: withId, attempt: 0 });
    await addDevice("s-flaky", u);
    stubFcm({ "s-flaky": fcmError(503, "UNAVAILABLE") });
    const last = [{ token: "s-flaky", userId: u }];
    await run({ kind: "tokens", targets: last, payload: withId, attempt: 4 });
    expect(
      await env.DB.prepare("SELECT sent, failed FROM push_stats WHERE id = ?").bind(pushId).first(),
    ).toEqual({ sent: 1, failed: 3 });
  });
});
