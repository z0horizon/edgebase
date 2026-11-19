import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { insertPersonal } from "../src/inbox/queries";
import { authed, call, json, signUpVerified } from "./helpers";

type SyncBody = {
  user: { id: string; email: string; adminNeedsTwoFactor: boolean };
  inbox?: { items: { id: string; title: string; read: boolean }[]; unreadCount: number };
};

const sync = (token: string, body: unknown) => call("/v1/sync", authed(token, json(body)));
const item = (title: string) => ({ title, body: "b", category: "transactional" as const });

it("POST /v1/sync does an app start in one call: device, opens, reads, user and inbox", async () => {
  const { userId, token } = await signUpVerified("sync-all@example.com");
  const now = Date.now();
  await insertPersonal(env.INBOX_DB, [userId], item("first"), now - 2000);
  await insertPersonal(env.INBOX_DB, [userId], item("second"), now - 1000);
  const pushId = 880_001;
  await env.DB.prepare(
    "INSERT INTO push_stats (id, category, send_at) VALUES (?, 'transactional', ?)",
  )
    .bind(pushId, now)
    .run();

  const first = await sync(token, {});
  expect(first.status).toBe(200);
  const start = await first.json<SyncBody>();
  expect(start.user).toMatchObject({
    id: userId,
    email: "sync-all@example.com",
    adminNeedsTwoFactor: false,
  });
  expect(start.inbox?.unreadCount).toBe(2);
  expect(start.inbox?.items.map((i) => i.title)).toEqual(["second", "first"]);
  const secondId = start.inbox?.items[0]?.id ?? "";

  // Writes land before the inbox is read, so the answer already shows them.
  const res = await sync(token, {
    device: { token: "sync-fcm-token", platform: "ios" },
    opens: [String(pushId), String(pushId), "999999999"],
    read: [secondId],
    inbox: { limit: 1 },
  });
  expect(res.status).toBe(200);
  const after = await res.json<SyncBody>();
  expect(after.inbox?.unreadCount).toBe(1);
  expect(after.inbox?.items).toHaveLength(1);
  expect(after.inbox?.items[0]).toMatchObject({ id: secondId, read: true });
  expect(
    await env.DB.prepare(
      "SELECT user_id, platform FROM device WHERE token = 'sync-fcm-token'",
    ).first(),
  ).toEqual({ user_id: userId, platform: "ios" });
  expect(
    await env.DB.prepare("SELECT opened FROM push_stats WHERE id = ?").bind(pushId).first("opened"),
  ).toBe(1);
  expect(
    await env.DB.prepare("SELECT count(*) AS n FROM push_open WHERE user_id = ?")
      .bind(userId)
      .first("n"),
  ).toBe(1);

  // readAll clears the rest; inbox: false leaves the list out.
  const cleared = await (await sync(token, { readAll: true, inbox: false })).json<SyncBody>();
  expect(cleared.inbox).toBeUndefined();
  expect((await (await sync(token, {})).json<SyncBody>()).inbox?.unreadCount).toBe(0);
});

it("POST /v1/sync validates its body and needs a session", async () => {
  const { token } = await signUpVerified("sync-bad@example.com");
  for (const body of [
    { device: { token: "t", platform: "windows" } },
    { opens: ["not-a-number"] },
    { opens: Array.from({ length: 21 }, (_, i) => String(i)) },
    { inbox: { limit: 101 } },
    { readAll: "yes" },
  ]) {
    const res = await sync(token, body);
    expect(res.status, JSON.stringify(body)).toBe(400);
  }
  expect((await call("/v1/sync", json({}))).status).toBe(401);
});
