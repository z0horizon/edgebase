import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { base64url, sha256 } from "../src/http";
import { authed, call, freshIp, json, PASSWORD, signUpVerified } from "./helpers";

/**
 * Calls until one answers 429, at most 21 times. The limiter's window may reset while a test
 * runs, so allow up to twice the limit before it trips.
 */
async function firstLimited(attempt: () => Promise<Response>): Promise<Response | undefined> {
  for (let i = 0; i < 21; i++) {
    const res = await attempt();
    if (res.status === 429) return res;
  }
  return undefined;
}

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

  describe("native app hand-off", () => {
    const VERIFIER = "v".repeat(43);
    const challengeOf = async (verifier: string) => base64url(await sha256(verifier));
    const handOff = async (email: string) => {
      const user = await signUpVerified(email);
      const challenge = await challengeOf(VERIFIER);
      const res = await call(`/v1/auth/app-callback?challenge=${challenge}`, authed(user.token));
      expect(res.status).toBe(302);
      const location = res.headers.get("location") ?? "";
      expect(location.startsWith("edgebase://auth?token=")).toBe(true);
      return { ...user, ott: new URL(location).searchParams.get("token") ?? "" };
    };
    const exchange = (token: string, verifier: string) =>
      call(
        "/v1/auth/app-exchange",
        json({ token, verifier }, { headers: { "cf-connecting-ip": freshIp() } }),
      );

    it("the right verifier exchanges the one-time token for a working session, once", async () => {
      const { userId, ott } = await handOff("e@x.io");
      const res = await exchange(ott, VERIFIER);
      expect(res.status).toBe(200);
      const { token } = await res.json<{ token: string }>();
      expect((await (await call("/v1/me", authed(token))).json<{ id: string }>()).id).toBe(userId);
      expect((await exchange(ott, VERIFIER)).status).toBe(401);
    });

    it("an app without the verifier cannot use an intercepted token", async () => {
      const { ott } = await handOff("e2@x.io");
      expect((await exchange(ott, "w".repeat(43))).status).toBe(401);
      // The token is spent by the failed attempt, so guessing again does not help.
      expect((await exchange(ott, VERIFIER)).status).toBe(401);
    });

    it.each([
      ["without a challenge", "", true, "invalid_challenge"],
      ["without a session", `?challenge=${"a".repeat(43)}`, false, "unauthorized"],
    ])("app-callback %s redirects the app with an error", async (_name, query, signedIn, error) => {
      const init = signedIn ? authed((await signUpVerified(`cb-${error}@x.io`)).token) : {};
      const res = await call(`/v1/auth/app-callback${query}`, init);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(`edgebase://auth?error=${error}`);
    });

    it("an expired hand-off token is refused even with the right verifier", async () => {
      const { ott } = await handOff("expired@x.io");
      await env.DB.prepare(
        "UPDATE verification SET expiresAt = ? WHERE identifier LIKE 'app-handoff:%'",
      )
        .bind(new Date(Date.now() - 1000).toISOString())
        .run();
      expect((await exchange(ott, VERIFIER)).status).toBe(401);
    });

    it("app-callback refuses a session that was not just created", async () => {
      const { userId, token } = await signUpVerified("stale@x.io");
      const tenMinutesAgo = new Date(Date.now() - 10 * 60_000).toISOString();
      await env.DB.prepare("UPDATE session SET createdAt = ? WHERE userId = ?")
        .bind(tenMinutesAgo, userId)
        .run();
      const challenge = await challengeOf(VERIFIER);
      const res = await call(`/v1/auth/app-callback?challenge=${challenge}`, authed(token));
      expect(res.headers.get("location")).toBe("edgebase://auth?error=unauthorized");
    });

    it("Better Auth's own one-time-token verify is not reachable", async () => {
      const { ott } = await handOff("e4@x.io");
      expect((await call("/api/auth/one-time-token/verify", json({ token: ott }))).status).toBe(
        404,
      );
    });
  });

  it("11th sign-in attempt within a minute from one IP answers 429", async () => {
    const attempt = () =>
      call(
        "/api/auth/sign-in/email",
        json({ email: "nobody@x.io", password: "wrong-password" }, { headers: ip(9) }),
      );
    const res = await firstLimited(attempt);
    expect(res?.status).toBe(429);
    expect((await res?.json<{ error: { code: string } }>())?.error.code).toBe("rate_limited");
  });

  it("missing BETTER_AUTH_SECRET answers 503 not_configured", async () => {
    const res = await call("/v1/me", {}, { ...env, BETTER_AUTH_SECRET: "" });
    expect(res.status).toBe(503);
    expect((await res.json<{ error: { code: string } }>()).error.code).toBe("not_configured");
  });
});

it.each(["/api/auth/send-verification-email", "/v1/auth/app-exchange"])(
  "11th call to %s within a minute from one IP answers 429",
  async (path) => {
    const headers = { "cf-connecting-ip": `203.0.113.${path.length}` };
    const attempt = () =>
      call(path, json({ email: "victim@x.io", token: "x", verifier: "x" }, { headers }));
    expect((await firstLimited(attempt))?.status).toBe(429);
  },
  // send-verification-email takes about 0.5 s per call under local workerd.
  20_000,
);

describe("social providers", () => {
  const social = (provider: string, bindings: Env) =>
    call(
      "/api/auth/sign-in/social",
      json(
        { provider, callbackURL: "https://web.test/" },
        { headers: { "cf-connecting-ip": freshIp() } },
      ),
      bindings,
    );

  it("a provider with credentials starts its OAuth flow", async () => {
    const res = await social("github", env);
    expect(res.status).toBe(200);
    expect((await res.json<{ url: string }>()).url).toContain("github.com");
  });

  it("a provider without credentials is turned off instead of breaking sign-in", async () => {
    const bindings = { ...env, GITHUB_CLIENT_ID: "", GITHUB_CLIENT_SECRET: "" };
    // An unconfigured provider must look absent (404), not crash the endpoint (500).
    expect((await social("github", bindings)).status).toBe(404);
    const signUp = await call(
      "/api/auth/sign-up/email",
      json(
        { email: "no-github@x.io", password: PASSWORD, name: "N" },
        { headers: { "cf-connecting-ip": freshIp() } },
      ),
      bindings,
    );
    expect(signUp.status).toBe(200);
  });
});

describe("captcha (Cloudflare Turnstile)", () => {
  const withKey = { ...env, TURNSTILE_SECRET_KEY: "turnstile-secret" } as Env;
  const stubTurnstile = (success: boolean) => {
    const original = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("https://challenges.cloudflare.com/")) return Response.json({ success });
      return original(input, init);
    });
  };
  const post = (path: string, body: unknown, bindings: Env, token?: string) =>
    call(
      path,
      json(body, {
        headers: { "cf-connecting-ip": freshIp(), ...(token && { "x-captcha-response": token }) },
      }),
      bindings,
    );
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["/api/auth/sign-up/email", { email: "cap1@x.io", password: PASSWORD, name: "c" }],
    ["/api/auth/request-password-reset", { email: "cap2@x.io" }],
    ["/api/auth/send-verification-email", { email: "cap3@x.io" }],
  ])("%s refuses a request without a Turnstile token once the key is set", async (path, body) => {
    expect((await post(path, body, withKey)).status).toBe(400);
  });

  it("a token Turnstile accepts lets sign-up through", async () => {
    stubTurnstile(true);
    const body = { email: "cap-ok@x.io", password: PASSWORD, name: "c" };
    expect((await post("/api/auth/sign-up/email", body, withKey, "good")).status).toBe(200);
  });

  it("a token Turnstile rejects is refused", async () => {
    stubTurnstile(false);
    const body = { email: "cap-bad@x.io", password: PASSWORD, name: "c" };
    expect((await post("/api/auth/sign-up/email", body, withKey, "bad")).status).toBe(403);
  });

  it("without the key, sign-up needs no token", async () => {
    const body = { email: "cap-off@x.io", password: PASSWORD, name: "c" };
    expect((await post("/api/auth/sign-up/email", body, env)).status).toBe(200);
  });
});

describe("admin, two-factor, organizations, locale", () => {
  it("admin routes refuse a user and accept one whose role is admin", async () => {
    const { userId, token } = await signUpVerified("admin@x.io");
    const list = () => call("/api/auth/admin/list-users", authed(token));
    expect((await list()).status).toBe(403);
    await env.DB.prepare("UPDATE user SET role = 'admin' WHERE id = ?").bind(userId).run();
    expect((await list()).status).toBe(200);
  });

  it("a banned user's session stops working", async () => {
    const admin = await signUpVerified("banner@x.io");
    await env.DB.prepare("UPDATE user SET role = 'admin' WHERE id = ?").bind(admin.userId).run();
    const target = await signUpVerified("banned@x.io");
    const ban = await call(
      "/api/auth/admin/ban-user",
      authed(admin.token, json({ userId: target.userId })),
    );
    expect(ban.status).toBe(200);
    expect((await call("/v1/me", authed(target.token))).status).toBe(401);
  });

  it("with 2FA on, password sign-in needs a second factor before it gets a session", async () => {
    const email = "tfa@x.io";
    const { userId, token } = await signUpVerified(email);
    const enable = await call(
      "/api/auth/two-factor/enable",
      authed(token, json({ password: PASSWORD })),
    );
    const { backupCodes } = await enable.json<{ backupCodes: string[] }>();
    // Stands in for confirming a TOTP code, which needs the secret's current time step.
    await env.DB.batch([
      env.DB.prepare("UPDATE user SET twoFactorEnabled = 1 WHERE id = ?").bind(userId),
      env.DB.prepare("UPDATE twoFactor SET verified = 1 WHERE userId = ?").bind(userId),
    ]);

    const headers = { "cf-connecting-ip": freshIp() };
    const signIn = await call(
      "/api/auth/sign-in/email",
      json({ email, password: PASSWORD }, { headers }),
    );
    expect(await signIn.json()).toMatchObject({ twoFactorRedirect: true });
    // The bearer plugin may still echo a token here; the session behind it was deleted.
    const early = signIn.headers.get("set-auth-token");
    if (early) expect((await call("/v1/me", authed(early))).status).toBe(401);

    const cookie = signIn.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const verify = await call(
      "/api/auth/two-factor/verify-backup-code",
      json({ code: backupCodes[0] }, { headers: { ...headers, cookie } }),
    );
    expect(verify.status).toBe(200);
    const bearer = verify.headers.get("set-auth-token") ?? "";
    expect((await call("/v1/me", authed(bearer))).status).toBe(200);
  });

  it("an organization is removed with its last member's account", async () => {
    const { token } = await signUpVerified("org-owner@x.io");
    const create = await call(
      "/api/auth/organization/create",
      authed(token, json({ name: "Acme", slug: "acme" })),
    );
    expect(create.status).toBe(200);
    const orgs = () =>
      env.DB.prepare("SELECT count(*) AS n FROM organization WHERE slug = 'acme'").first("n");
    expect(await orgs()).toBe(1);
    await call("/api/auth/delete-user", authed(token, json({ password: PASSWORD })));
    expect(await orgs()).toBe(0);
  });

  it("admin remove-user also deletes the user's inbox and opens", async () => {
    const admin = await signUpVerified("remover@x.io");
    await env.DB.prepare("UPDATE user SET role = 'admin' WHERE id = ?").bind(admin.userId).run();
    const target = await signUpVerified("removed@x.io");
    await env.INBOX_DB.prepare(
      "INSERT INTO inbox_item (user_id, title, body, category, created_at) VALUES (?, 't', 'b', 'transactional', 1)",
    )
      .bind(target.userId)
      .run();
    await env.DB.prepare("INSERT INTO push_open VALUES (1, ?)").bind(target.userId).run();
    const res = await call(
      "/api/auth/admin/remove-user",
      authed(admin.token, json({ userId: target.userId })),
    );
    expect(res.status).toBe(200);
    const left = async (db: D1Database, table: string) =>
      db
        .prepare(`SELECT count(*) AS n FROM ${table} WHERE user_id = ?`)
        .bind(target.userId)
        .first("n");
    expect(await left(env.INBOX_DB, "inbox_item")).toBe(0);
    expect(await left(env.DB, "push_open")).toBe(0);
  });

  it("invite-member is rate-limited per IP, since it mails any address", async () => {
    const { token } = await signUpVerified("inviter@x.io");
    const headers = { "cf-connecting-ip": freshIp() };
    const res = await firstLimited(() =>
      call(
        "/api/auth/organization/invite-member",
        authed(token, json({ email: "victim@x.io", role: "member", resend: true }, { headers })),
      ),
    );
    expect(res?.status).toBe(429);
  });

  it("update-user takes a BCP 47 locale and refuses anything else", async () => {
    const { userId, token } = await signUpVerified("locale@x.io");
    const update = (locale: string) =>
      call("/api/auth/update-user", authed(token, json({ locale })));
    expect((await update("not a locale")).status).toBe(400);
    const locale = () =>
      env.DB.prepare("SELECT locale FROM user WHERE id = ?").bind(userId).first("locale");
    expect((await update("vi-VN")).status).toBe(200);
    expect(await locale()).toBe("vi-VN");
    const clear = await call("/api/auth/update-user", authed(token, json({ locale: null })));
    expect(clear.status).toBe(200);
    expect(await locale()).toBeNull();
  });
});
