import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  authed,
  call,
  fakeQueue,
  json,
  makeServiceAccount,
  seedUser,
  signUpVerified,
} from "./helpers";

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
const withPushId = (payload: object, id: number) => ({ ...payload, data: { pushId: String(id) } });
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
    const answer = await (await res).json<{ id: number }>();
    const { id } = answer;
    expect(answer).toEqual({ id, users: 1 });
    expect(await inboxCount(u)).toBe(1);
    expect(await inboxCount("ghost")).toBe(0);
    expect(sent).toEqual([
      {
        body: { kind: "users", userIds: [u], payload: withPushId(base, id), attempt: 0 },
        delaySeconds: undefined,
      },
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
    expect(await (await res).json()).toMatchObject({ users: 1 });
    expect(sent.map((s) => (s.body as { userIds: string[] }).userIds)).toEqual([[optedIn]]);
    expect(await inboxCount(optedOut)).toBe(0);
  });

  it("topic with inbox writes one broadcast row and one topic message", async () => {
    const before = await env.INBOX_DB.prepare("SELECT count(*) AS n FROM broadcast").first<number>(
      "n",
    );
    const { res, sent } = push({ ...base, to: { topic: "all" }, inbox: true });
    const { id } = await (await res).json<{ id: number }>();
    expect(await env.INBOX_DB.prepare("SELECT count(*) AS n FROM broadcast").first("n")).toBe(
      (before ?? 0) + 1,
    );
    expect(sent).toEqual([
      {
        body: { kind: "topic", topic: "all", payload: withPushId(base, id), attempt: 0 },
        delaySeconds: undefined,
      },
    ]);
  });

  it("sendAt stores scheduled_push and enqueues nothing", async () => {
    const sendAt = new Date(Date.now() + 3_600_000).toISOString();
    const { res, sent } = push({ ...base, to: { topic: "later" }, sendAt });
    expect(await (await res).json()).toEqual({ id: expect.any(Number), scheduled: true });
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

describe("Idempotency-Key", () => {
  const withKey = (key: string) => ({ ...KEY, "idempotency-key": key });

  it("a repeat replays the first answer and dispatches once", async () => {
    const u = await seedUser();
    const body = { ...base, to: { userIds: [u] } };
    const first = push(body, {}, withKey("k-repeat"));
    const firstAnswer = await (await first.res).json();
    const second = push(body, {}, withKey("k-repeat"));
    const res = await second.res;
    expect(res.status).toBe(202);
    expect(res.headers.get("idempotent-replayed")).toBe("true");
    expect(await res.json()).toEqual(firstAnswer);
    expect(first.sent).toHaveLength(1);
    expect(second.sent).toEqual([]);
  });

  it("the same key with another body answers 422", async () => {
    await (await push({ ...base, to: { topic: "a" } }, {}, withKey("k-mismatch")).res).text();
    const { res } = push({ ...base, to: { topic: "b" } }, {}, withKey("k-mismatch"));
    expect((await res).status).toBe(422);
  });

  it("a key whose first request is still running answers 409", async () => {
    const body = { ...base, to: { topic: "a" } };
    await (await push(body, {}, withKey("k-busy")).res).text();
    await env.DB.prepare("UPDATE push_idempotency SET response = NULL WHERE key = 'k-busy'").run();
    const { res, sent } = push(body, {}, withKey("k-busy"));
    expect((await res).status).toBe(409);
    expect(sent).toEqual([]);
  });

  it("a rejected request frees its key", async () => {
    await (await push({ ...base, to: { topic: "a" }, title: "" }, {}, withKey("k-fix")).res).text();
    await (
      await push({ ...base, template: "missing", to: { topic: "a" } }, {}, withKey("k-fix")).res
    ).text();
    const { res } = push({ ...base, to: { topic: "a" } }, {}, withKey("k-fix"));
    expect((await res).status).toBe(202);
  });
});

describe("templates and translations", () => {
  const putTemplate = (name: string, body: object) =>
    call(`/v1/templates/${name}`, json(body, { method: "PUT", headers: KEY }), {
      ...env,
      FCM_SERVICE_ACCOUNT: SA,
    });
  const setLocale = (id: string, locale: string | null) =>
    env.DB.prepare("UPDATE user SET locale = ? WHERE id = ?").bind(locale, id).run();

  it("renders vars and sends each user the text of their locale or language", async () => {
    const [vi, enUs, none] = [await seedUser(), await seedUser(), await seedUser()];
    await setLocale(vi, "vi-VN");
    await setLocale(enUs, "en-US");
    expect(
      (
        await putTemplate("shipped", {
          title: "Order {{order}} shipped",
          body: "On its way",
          category: "transactional",
          data: { orderId: "{{order}}" },
          translations: {
            vi: { title: "Đơn {{order}} đã gửi", body: "Đang giao" },
            "en-US": { title: "Order {{order}} is out", body: "Coming" },
          },
        })
      ).status,
    ).toBe(204);

    const { res, sent } = push({
      template: "shipped",
      vars: { order: "42" },
      to: { userIds: [vi, enUs, none] },
      inbox: true,
    });
    expect((await res).status).toBe(202);
    const byUser = new Map(
      sent.flatMap((s) => {
        const m = s.body as { userIds: string[]; payload: { title: string; data: object } };
        return m.userIds.map((u) => [u, m.payload] as const);
      }),
    );
    expect(byUser.get(vi)?.title).toBe("Đơn 42 đã gửi");
    expect(byUser.get(enUs)?.title).toBe("Order 42 is out");
    expect(byUser.get(none)?.title).toBe("Order 42 shipped");
    expect(byUser.get(none)?.data).toMatchObject({ orderId: "42" });
    const inboxTitle = (u: string) =>
      env.INBOX_DB.prepare("SELECT title FROM inbox_item WHERE user_id = ?").bind(u).first("title");
    expect(await inboxTitle(vi)).toBe("Đơn 42 đã gửi");
    expect(await inboxTitle(none)).toBe("Order 42 shipped");
  });

  it("the request's own fields override the template's", async () => {
    await putTemplate("promo", { title: "Sale", body: "Now", category: "transactional" });
    const { res } = push({ template: "promo", title: "Flash sale", to: { topic: "all" } });
    expect((await res).status).toBe(202);
  });

  it.each([
    ["an unknown template", { template: "nope" }],
    ["a missing var", { template: "needs-var" }],
    ["a rendered title over 120 chars", { template: "needs-var", vars: { v: "x".repeat(130) } }],
  ])("%s → 400", async (_name, patch) => {
    await putTemplate("needs-var", { title: "Hi {{v}}", body: "", category: "transactional" });
    const { res } = push({ to: { topic: "all" }, ...patch });
    expect((await res).status).toBe(400);
  });

  it("GET returns a stored template, DELETE removes it", async () => {
    await putTemplate("tmp", { title: "T", body: "B" });
    const get = () =>
      call("/v1/templates/tmp", { headers: KEY }, { ...env, FCM_SERVICE_ACCOUNT: SA });
    expect(await (await get()).json()).toEqual({ title: "T", body: "B" });
    await call(
      "/v1/templates/tmp",
      { method: "DELETE", headers: KEY },
      { ...env, FCM_SERVICE_ACCOUNT: SA },
    );
    expect((await get()).status).toBe(404);
  });
});

describe("push stats", () => {
  it("GET /v1/push/:id counts targeted users and each user's open once", async () => {
    const { userId, token } = await signUpVerified("opens@x.io");
    const { res } = push({ ...base, to: { userIds: [userId] } });
    const { id } = await (await res).json<{ id: number }>();
    for (let i = 0; i < 2; i++) {
      const open = await call("/v1/opens", authed(token, json({ pushId: String(id) })));
      expect(open.status).toBe(204);
    }
    const stats = await call(
      `/v1/push/${id}`,
      { headers: KEY },
      { ...env, FCM_SERVICE_ACCOUNT: SA },
    );
    expect(await stats.json()).toMatchObject({ id, users: 1, sent: 0, failed: 0, opened: 1 });
  });

  it("stats need the API key", async () => {
    expect((await call("/v1/push/1", {}, { ...env, FCM_SERVICE_ACCOUNT: SA })).status).toBe(401);
  });
});

describe("admin session on server routes (the /admin page)", () => {
  const bindings = () => ({ ...env, FCM_SERVICE_ACCOUNT: SA });
  const asAdmin = async (email: string, admin: boolean) => {
    const { userId, token } = await signUpVerified(email);
    if (admin)
      await env.DB.prepare("UPDATE user SET role = 'admin' WHERE id = ?").bind(userId).run();
    return token;
  };

  it("an admin from the Worker's own origin lists pushes and templates", async () => {
    const token = await asAdmin("page-admin@x.io", true);
    const own = { origin: "https://api.test" };
    expect((await call("/v1/push", authed(token, { headers: own }), bindings())).status).toBe(200);
    const res = await call("/v1/templates", authed(token), bindings());
    expect(await res.json()).toMatchObject({ templates: expect.any(Array) });
  });

  it("refuses a non-admin, and an admin's session sent from another origin", async () => {
    const user = await asAdmin("page-user@x.io", false);
    expect((await call("/v1/push", authed(user), bindings())).status).toBe(401);
    const admin = await asAdmin("page-admin-2@x.io", true);
    const foreign = authed(
      admin,
      json({ ...base, to: { topic: "all" } }, { headers: { origin: "https://evil.test" } }),
    );
    expect((await call("/v1/push", foreign, bindings())).status).toBe(401);
  });

  it("refuses an admin's write that carries no Origin", async () => {
    const admin = await asAdmin("page-admin-3@x.io", true);
    const res = await call(
      "/v1/push",
      authed(admin, json({ ...base, to: { topic: "all" } })),
      bindings(),
    );
    expect(res.status).toBe(401);
  });
});
