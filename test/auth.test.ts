import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { authed, call, json, PASSWORD, signUpVerified } from "./helpers";

const ip = (n: number) => ({ "cf-connecting-ip": `203.0.113.${n}` });

describe("auth", () => {
  it("unverified email cannot sign in", async () => {
    await call("/api/auth/sign-up/email", json({ email: "a@x.io", password: PASSWORD, name: "A" }));
    const res = await call(
      "/api/auth/sign-in/email",
      json({ email: "a@x.io", password: PASSWORD }),
    );
    expect(res.status).toBe(403);
  });

  it("bearer token reaches a requireUser route", async () => {
    const { userId, token } = await signUpVerified("b@x.io");
    const res = await call("/v1/me", authed(token));
    expect(res.status).toBe(200);
    expect((await res.json<{ id: string }>()).id).toBe(userId);
  });

  it("no session answers 401 in the error shape", async () => {
    const res = await call("/v1/me");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: "unauthorized", message: expect.any(String) },
    });
  });

  it("token reused after sign-out answers 401", async () => {
    const { token } = await signUpVerified("c@x.io");
    await call("/api/auth/sign-out", authed(token, json({})));
    expect((await call("/v1/me", authed(token))).status).toBe(401);
  });

  it("deleting a user removes its devices and inbox rows", async () => {
    const { userId, token } = await signUpVerified("d@x.io");
    await env.DB.prepare("INSERT INTO device VALUES ('tok-d', ?, 'ios', 0)").bind(userId).run();
    await env.INBOX_DB.batch([
      env.INBOX_DB.prepare(
        "INSERT INTO inbox_item (user_id, title, body, category, created_at) VALUES (?, 't', 'b', 'transactional', 1)",
      ).bind(userId),
      env.INBOX_DB.prepare("INSERT INTO inbox_state VALUES (?, 1)").bind(userId),
    ]);
    const res = await call("/api/auth/delete-user", authed(token, json({ password: PASSWORD })));
    expect(res.status).toBe(200);
    const count = async (db: D1Database, table: string) =>
      db.prepare(`SELECT count(*) AS n FROM ${table} WHERE user_id = ?`).bind(userId).first("n");
    expect(await count(env.DB, "device")).toBe(0);
    expect(await count(env.INBOX_DB, "inbox_item")).toBe(0);
    expect(await count(env.INBOX_DB, "inbox_state")).toBe(0);
  });

  it("app-callback redirects to the app scheme with a one-time token that yields a session", async () => {
    const { userId, token } = await signUpVerified("e@x.io");
    const res = await call("/v1/auth/app-callback", authed(token));
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith("edgebase://auth?token=")).toBe(true);
    const ott = new URL(location).searchParams.get("token");
    const verify = () => call("/api/auth/one-time-token/verify", json({ token: ott }));
    const first = await verify();
    expect((await first.json<{ user: { id: string } }>()).user.id).toBe(userId);
    expect((await verify()).ok).toBe(false);
  });

  it("11th sign-in attempt within a minute from one IP answers 429", async () => {
    const attempt = () =>
      call(
        "/api/auth/sign-in/email",
        json({ email: "nobody@x.io", password: "wrong-password" }, { headers: ip(9) }),
      );
    for (let i = 0; i < 10; i++) expect((await attempt()).status).not.toBe(429);
    const res = await attempt();
    expect(res.status).toBe(429);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("rate_limited");
  });

  it("missing BETTER_AUTH_SECRET answers 503 not_configured", async () => {
    const res = await call("/v1/me", {}, { ...env, BETTER_AUTH_SECRET: "" });
    expect(res.status).toBe(503);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("not_configured");
  });
});
