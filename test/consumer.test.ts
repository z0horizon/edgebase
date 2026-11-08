import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { handlePushBatch } from "../src/push/consumer";
import { resetFcmCacheForTests } from "../src/push/fcm";
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

async function run(body: PushQueueMessage) {
  const queue = fakeQueue();
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
    stubFcm({ t2: fcmError(503, "UNAVAILABLE") });
    const { queued, result } = await run({
      kind: "tokens",
      tokens: ["t1", "t2", "t3"],
      payload,
      attempt: 0,
    });
    expect(queued).toEqual([
      { body: { kind: "tokens", tokens: ["t2"], payload, attempt: 1 }, delaySeconds: 30 },
    ]);
    expect(result.explicitAcks).toEqual(["m1"]);
  });

  it("the fifth failed attempt goes to the DLQ, not the queue", async () => {
    stubFcm({ t9: fcmError(503, "UNAVAILABLE") });
    const { queued, dead } = await run({ kind: "tokens", tokens: ["t9"], payload, attempt: 4 });
    expect(queued).toEqual([]);
    expect(dead).toEqual([
      { body: { kind: "tokens", tokens: ["t9"], payload, attempt: 5 }, delaySeconds: undefined },
    ]);
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
});
