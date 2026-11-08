import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { call, fakeQueue, json, makeServiceAccount, seedUser } from "./helpers";

let SA = "";
beforeAll(async () => {
  SA = (await makeServiceAccount()).json;
});

const KEY = { "x-api-key": "test-push-key" };
const base = { title: "Hi", body: "Hello", category: "transactional" };

function push(body: object, overrides: Partial<Env> = {}, headers: HeadersInit = KEY) {
  const q = fakeQueue();
  const bindings = { ...env, FCM_SERVICE_ACCOUNT: SA, PUSH_QUEUE: q.queue, ...overrides };
  return { res: call("/v1/push", json(body, { headers }), bindings), sent: q.sent };
}
const inboxCount = (userId: string) =>
  env.INBOX_DB.prepare("SELECT count(*) AS n FROM inbox_item WHERE user_id = ?")
    .bind(userId)
    .first("n");

describe("POST /v1/push", () => {
  it("wrong X-API-Key answers 401", async () => {
    const { res } = push({ ...base, to: { topic: "all" } }, {}, { "x-api-key": "nope" });
    expect((await res).status).toBe(401);
  });

  it("missing FCM_SERVICE_ACCOUNT answers 503", async () => {
    const { res } = push({ ...base, to: { topic: "all" } }, { FCM_SERVICE_ACCOUNT: "" });
    expect((await res).status).toBe(503);
  });

  it.each([
    ["title over 120 chars", { title: "x".repeat(121) }],
    ["body over 500 chars", { body: "x".repeat(501) }],
    ["data over 1 KB", { data: { k: "x".repeat(1100) } }],
    ["501 userIds", { to: { userIds: Array.from({ length: 501 }, (_, i) => `u${i}`) } }],
    ["no userIds", { to: { userIds: [] } }],
    ["unknown category", { category: "spam" }],
    ["sendAt in the past", { sendAt: "2000-01-01T00:00:00Z" }],
    ["sendAt not ISO", { sendAt: "tomorrow" }],
  ])("%s → 400", async (_name, patch) => {
    const { res } = push({ ...base, to: { topic: "all" }, ...patch });
    expect((await res).status).toBe(400);
  });

  it("duplicate and unknown userIds: one inbox row and one queued id per real user", async () => {
    const u = await seedUser();
    const { res, sent } = push({ ...base, to: { userIds: [u, u, "ghost"] }, inbox: true });
    expect(await (await res).json()).toEqual({ users: 1 });
    expect(await inboxCount(u)).toBe(1);
    expect(await inboxCount("ghost")).toBe(0);
    expect(sent).toEqual([
      { body: { kind: "users", userIds: [u], payload: base, attempt: 0 }, delaySeconds: undefined },
    ]);
  });

  it("splits 120 users into queue messages of at most 50", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 120; i++) ids.push(await seedUser());
    const { res, sent } = push({ ...base, to: { userIds: ids } });
    expect((await res).status).toBe(202);
    expect(sent.map((s) => (s.body as { userIds: string[] }).userIds.length)).toEqual([50, 50, 20]);
  });

  it("marketing skips users without marketingOptIn", async () => {
    const [optedIn, optedOut] = [await seedUser(), await seedUser()];
    await env.DB.prepare("UPDATE user SET marketingOptIn = 1 WHERE id = ?").bind(optedIn).run();
    const { res, sent } = push({
      ...base,
      category: "marketing",
      to: { userIds: [optedIn, optedOut] },
      inbox: true,
    });
    expect(await (await res).json()).toEqual({ users: 1 });
    expect(sent.map((s) => (s.body as { userIds: string[] }).userIds)).toEqual([[optedIn]]);
    expect(await inboxCount(optedOut)).toBe(0);
  });

  it("topic with inbox writes one broadcast row and one topic message", async () => {
    const before = await env.INBOX_DB.prepare("SELECT count(*) AS n FROM broadcast").first<number>(
      "n",
    );
    const { res, sent } = push({ ...base, to: { topic: "all" }, inbox: true });
    expect((await res).status).toBe(202);
    expect(await env.INBOX_DB.prepare("SELECT count(*) AS n FROM broadcast").first("n")).toBe(
      (before ?? 0) + 1,
    );
    expect(sent).toEqual([
      { body: { kind: "topic", topic: "all", payload: base, attempt: 0 }, delaySeconds: undefined },
    ]);
  });

  it("sendAt stores scheduled_push and enqueues nothing", async () => {
    const sendAt = new Date(Date.now() + 3_600_000).toISOString();
    const { res, sent } = push({ ...base, to: { topic: "later" }, sendAt });
    expect(await (await res).json()).toEqual({ scheduled: true });
    expect(sent).toEqual([]);
    const row = await env.DB.prepare(
      "SELECT send_at, request FROM scheduled_push ORDER BY id DESC LIMIT 1",
    ).first<{
      send_at: number;
      request: string;
    }>();
    expect(row?.send_at).toBe(Date.parse(sendAt));
    expect(JSON.parse(row?.request ?? "{}")).toEqual({ ...base, to: { topic: "later" } });
  });

  it("a user session does not reach /v1/push", async () => {
    const { res } = push({ ...base, to: { topic: "all" } }, {}, { authorization: "Bearer x" });
    expect((await res).status).toBe(401);
  });
});
