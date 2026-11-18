import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { socialProviderOf } from "../src/auth/auth";
import { base64url, sha256 } from "../src/http";
import { authed, call, freshIp, json, PASSWORD, signUpVerified } from "./helpers";
import { createVirtualPasskey } from "./webauthn-helper";

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

/** Runs GitHub OAuth through Better Auth, with github.com answering for `email`. */
async function githubOAuth(email: string, opts: { linkWith?: string; callbackURL?: string } = {}) {
  const headers = { "cf-connecting-ip": freshIp() };
  const body = { provider: "github", callbackURL: opts.callbackURL ?? "/admin/" };
  const start = await call(
    opts.linkWith ? "/api/auth/link-social" : "/api/auth/sign-in/social",
    opts.linkWith ? authed(opts.linkWith, json(body, { headers })) : json(body, { headers }),
  );
  const { url } = await start.json<{ url: string }>();
  const state = new URL(url).searchParams.get("state");
  const github: Record<string, unknown> = {
    "https://github.com/login/oauth/access_token": { access_token: "gh", token_type: "bearer" },
    // One GitHub account per email, as on github.com.
    "https://api.github.com/user": { id: email, login: "octo", name: "Octo", email },
    "https://api.github.com/user/emails": [{ email, primary: true, verified: true }],
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new Request(input).url.split("?")[0] ?? "";
    if (!(url in github)) throw new Error(`unexpected fetch ${url}`);
    return Response.json(github[url]);
  });
  const cookie = start.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const init = { headers: { ...headers, cookie } };
  const callback = await call(
    `/api/auth/callback/github?code=c&state=${state}`,
    opts.linkWith ? authed(opts.linkWith, init) : init,
  );
  vi.restoreAllMocks();
  const session = callback.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return {
    location: callback.headers.get("location") ?? "",
    session: { headers: { cookie: session, origin: "https://web.test" } },
  };
}

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
    const startOAuthHandOff = async (email: string, challenge: string) => {
      const callbackURL = `https://api.test/v1/auth/app-callback?challenge=${challenge}`;
      const oauth = await githubOAuth(email, { callbackURL });
      expect(oauth.location).toBe(callbackURL);
      const me = await (await call("/v1/me", oauth.session)).json<{ id: string }>();
      return { userId: me.id, session: oauth.session };
    };
    const handOff = async (email: string) => {
      const challenge = await challengeOf(VERIFIER);
      const { userId, session } = await startOAuthHandOff(email, challenge);
      const res = await call(`/v1/auth/app-callback?challenge=${challenge}`, session);
      expect(res.status).toBe(302);
      const location = res.headers.get("location") ?? "";
      expect(location.startsWith("edgebase://auth?token=")).toBe(true);
      return { userId, session, ott: new URL(location).searchParams.get("token") ?? "" };
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

    it("app-callback refuses a fresh password or web OAuth session that did not start a hand-off", async () => {
      const challenge = await challengeOf(VERIFIER);
      const passwordUser = await signUpVerified("pw-no-handoff@x.io");
      const pwRes = await call(
        `/v1/auth/app-callback?challenge=${challenge}`,
        authed(passwordUser.token),
      );
      expect(pwRes.headers.get("location")).toBe("edgebase://auth?error=unauthorized");

      const webOAuth = await githubOAuth("web-no-handoff@x.io", {
        callbackURL: "https://web.test/",
      });
      const webRes = await call(`/v1/auth/app-callback?challenge=${challenge}`, webOAuth.session);
      expect(webRes.headers.get("location")).toBe("edgebase://auth?error=unauthorized");
    });

    it("app-callback binds the challenge to the OAuth state and allows only one hand-off", async () => {
      const challenge = await challengeOf(VERIFIER);
      const otherChallenge = await challengeOf("x".repeat(43));
      const { session } = await startOAuthHandOff("bound-handoff@x.io", challenge);

      const wrong = await call(`/v1/auth/app-callback?challenge=${otherChallenge}`, session);
      expect(wrong.headers.get("location")).toBe("edgebase://auth?error=unauthorized");

      const ok = await call(`/v1/auth/app-callback?challenge=${challenge}`, session);
      expect(ok.headers.get("location")?.startsWith("edgebase://auth?token=")).toBe(true);

      const replay = await call(`/v1/auth/app-callback?challenge=${challenge}`, session);
      expect(replay.headers.get("location")).toBe("edgebase://auth?error=unauthorized");
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

    it("app-callback refuses an expired OAuth challenge binding even while the session is fresh", async () => {
      const challenge = await challengeOf(VERIFIER);
      const { session } = await startOAuthHandOff("expired-cb@x.io", challenge);
      await env.DB.prepare(
        "UPDATE verification SET expiresAt = ? WHERE identifier LIKE 'app-callback:%'",
      )
        .bind(new Date(Date.now() - 1000).toISOString())
        .run();
      const res = await call(`/v1/auth/app-callback?challenge=${challenge}`, session);
      expect(res.headers.get("location")).toBe("edgebase://auth?error=unauthorized");
    });

    it("app-callback refuses a session that was not just created", async () => {
      const challenge = await challengeOf(VERIFIER);
      const { userId, session } = await startOAuthHandOff("stale@x.io", challenge);
      const tenMinutesAgo = new Date(Date.now() - 10 * 60_000).toISOString();
      await env.DB.prepare("UPDATE session SET createdAt = ? WHERE userId = ?")
        .bind(tenMinutesAgo, userId)
        .run();
      const res = await call(`/v1/auth/app-callback?challenge=${challenge}`, session);
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

it.each([
  "/api/auth/send-verification-email",
  "/api/auth/reset-password",
  "/api/auth/change-password",
  "/api/auth/verify-password",
  "/api/auth/delete-user",
  "/v1/auth/app-exchange",
])(
  "11th call to %s within a minute from one IP answers 429",
  async (path) => {
    const headers = { "cf-connecting-ip": freshIp() };
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

  it("GET /v1/auth/providers lists only providers with credentials", async () => {
    const providers = async (bindings: Env) =>
      (await (await call("/v1/auth/providers", {}, bindings)).json<{ providers: string[] }>())
        .providers;
    expect(await providers(env)).toContain("github");
    expect(
      await providers({ ...env, GITHUB_CLIENT_ID: "", GITHUB_CLIENT_SECRET: "" }),
    ).not.toContain("github");
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
  afterEach(() => vi.restoreAllMocks());

  it("admin routes refuse a user and accept one whose role is admin", async () => {
    const { userId, token } = await signUpVerified("admin@x.io");
    const list = () => call("/api/auth/admin/list-users", authed(token));
    expect((await list()).status).toBe(403);
    await env.DB.prepare("UPDATE user SET role = 'admin', twoFactorEnabled = 1 WHERE id = ?")
      .bind(userId)
      .run();
    expect((await list()).status).toBe(200);
  });

  it("an admin without two-factor gets 403 two_factor_required until TOTP is on", async () => {
    const { userId, token } = await signUpVerified("admin-no-tfa@x.io");
    await env.DB.prepare("UPDATE user SET role = 'admin' WHERE id = ?").bind(userId).run();
    const list = await call("/api/auth/admin/list-users", authed(token));
    expect(list.status).toBe(403);
    expect(await list.json()).toMatchObject({ error: { code: "two_factor_required" } });
    const me = await call("/v1/me", authed(token));
    expect(await me.json()).toMatchObject({ adminNeedsTwoFactor: true });
    // Setting it up stays open, or the admin could never get in.
    const enable = await call(
      "/api/auth/two-factor/enable",
      authed(token, json({ password: PASSWORD })),
    );
    expect(enable.status).toBe(200);
  });

  const githubLinked = (userId: string) =>
    env.DB.prepare("SELECT count(*) AS n FROM account WHERE userId = ? AND providerId = 'github'")
      .bind(userId)
      .first("n");

  it("a user who signed up with GitHub and was made admin reaches admin routes without TOTP", async () => {
    const signUp = await githubOAuth("gh-new-admin@x.io");
    expect(signUp.location).toBe("/admin/");
    const me = await (await call("/api/auth/get-session", signUp.session)).json<{
      user: { id: string };
    }>();
    await env.DB.prepare("UPDATE user SET role = 'admin' WHERE id = ?").bind(me.user.id).run();
    expect((await call("/api/auth/admin/list-users", signUp.session)).status).toBe(200);
    expect(await (await call("/api/auth/get-session", signUp.session)).json()).toMatchObject({
      session: { signInProvider: "github" },
    });
    expect(await (await call("/v1/me", signUp.session)).json()).toMatchObject({
      adminNeedsTwoFactor: false,
    });
  });

  it("GitHub joins an admin only when linked from a session that passed two-factor", async () => {
    const email = "admin-link@x.io";
    const { userId, token } = await signUpVerified(email);
    await env.DB.prepare("UPDATE user SET role = 'admin' WHERE id = ?").bind(userId).run();

    // Owning the inbox: a GitHub account with the admin's verified email signs in.
    expect((await githubOAuth(email)).location).toContain("error=");
    // Knowing the password: the password session has not passed two-factor.
    expect((await githubOAuth(email, { linkWith: token })).location).toContain("error=");
    expect(await githubLinked(userId)).toBe(0);

    await env.DB.prepare("UPDATE user SET twoFactorEnabled = 1 WHERE id = ?").bind(userId).run();
    expect((await githubOAuth(email, { linkWith: token })).location).toBe("/admin/");
    expect(await githubLinked(userId)).toBe(1);
    const signIn = await githubOAuth(email);
    expect(signIn.location).toBe("/admin/");
    expect((await call("/api/auth/admin/list-users", signIn.session)).status).toBe(200);
  });

  it("a client cannot mark its password session as social", async () => {
    const { userId, token } = await signUpVerified("admin-forge@x.io");
    await env.DB.prepare("UPDATE user SET role = 'admin' WHERE id = ?").bind(userId).run();
    const forge = await call(
      "/api/auth/update-session",
      authed(
        token,
        json({ signInProvider: "github" }, { headers: { "cf-connecting-ip": freshIp() } }),
      ),
    );
    expect(forge.status).toBe(400);
    expect((await call("/api/auth/admin/list-users", authed(token))).status).toBe(403);
  });

  it.each([
    [{ path: "/callback/:id", params: { id: "github" } }, "github"],
    [{ path: "/sign-in/social", body: { provider: "apple" } }, "apple"],
    [{ path: "/callback/:id", params: { id: "evil" } }, null],
    [{ path: "/sign-in/email", body: { provider: "google" } }, null],
    [{ path: "/two-factor/verify-totp" }, null],
    [null, null],
  ])("socialProviderOf(%j) is %s", (ctx, expected) => {
    expect(socialProviderOf(ctx)).toBe(expected);
  });

  it("a banned user's session stops working and their trusted devices are revoked", async () => {
    const admin = await signUpVerified("banner@x.io");
    await env.DB.prepare("UPDATE user SET role = 'admin', twoFactorEnabled = 1 WHERE id = ?")
      .bind(admin.userId)
      .run();
    const target = await signUpVerified("banned@x.io");
    await env.DB.prepare(
      `INSERT INTO trusted_device (id, token_hash, user_id, created_at, last_used_at, expires_at)
       VALUES ('td-banned', 'hash-banned', ?, 1, 1, ?)`,
    )
      .bind(target.userId, Date.now() + 86_400_000)
      .run();
    const ban = await call(
      "/api/auth/admin/ban-user",
      authed(admin.token, json({ userId: target.userId })),
    );
    expect(ban.status).toBe(200);
    expect((await call("/v1/me", authed(target.token))).status).toBe(401);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM trusted_device WHERE user_id = ?")
        .bind(target.userId)
        .first("n"),
    ).toBe(0);
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
    await env.DB.prepare("UPDATE user SET role = 'admin', twoFactorEnabled = 1 WHERE id = ?")
      .bind(admin.userId)
      .run();
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

describe("session network telemetry and freshness", () => {
  it("records origin and current IP/ASN/geo from cf-connecting-ip and request.cf, and refuses client forgery", async () => {
    const email = "net@x.io";
    await signUpVerified(email);
    const clientIp = freshIp();
    const signIn = await call("/api/auth/sign-in/email", {
      ...json(
        { email, password: PASSWORD },
        {
          headers: {
            "cf-connecting-ip": clientIp,
            "x-forwarded-for": "192.0.2.99",
            "user-agent": "EdgeBaseTest/1.0",
          },
        },
      ),
      cf: { asn: 45899, asOrganization: "VNPT Corp", country: "VN", city: "Hanoi" },
    });
    expect(signIn.status).toBe(200);
    const token = signIn.headers.get("set-auth-token") ?? "";

    const listed = await call("/v1/sessions", authed(token));
    expect(listed.status).toBe(200);
    const { sessions } = await listed.json<{ sessions: Array<Record<string, unknown>> }>();
    const current = sessions.find((s) => s["ipAddress"] === clientIp);
    expect(current).toMatchObject({
      ipAddress: clientIp,
      userAgent: "EdgeBaseTest/1.0",
      asn: 45899,
      asOrganization: "VNPT Corp",
      country: "VN",
      city: "Hanoi",
      createdIp: clientIp,
      createdAsn: 45899,
      createdAsOrganization: "VNPT Corp",
      createdCountry: "VN",
      createdCity: "Hanoi",
    });
    expect(typeof current?.["lastActiveAt"]).toBe("string");

    const forge = await call(
      "/api/auth/update-session",
      authed(
        token,
        json({ asn: 13335, createdCountry: "US" }, { headers: { "cf-connecting-ip": freshIp() } }),
      ),
    );
    expect(forge.status).toBe(400);
  });

  it("updates current network and lastActiveAt on ASN shift or after 15 minutes while keeping origin immutable", async () => {
    const email = "roam@x.io";
    await signUpVerified(email);
    const originIp = freshIp();
    const signIn = await call("/api/auth/sign-in/email", {
      ...json({ email, password: PASSWORD }, { headers: { "cf-connecting-ip": originIp } }),
      cf: { asn: 45899, asOrganization: "VNPT Corp", country: "VN", city: "Hanoi" },
    });
    const token = signIn.headers.get("set-auth-token") ?? "";
    const {
      session: { id: sessionId },
    } = await (await call("/api/auth/get-session", authed(token))).json<{
      session: { id: string };
    }>();
    const sessionRow = () =>
      env.DB.prepare(
        `SELECT ipAddress, asn, asOrganization, country, city,
                createdIp, createdAsn, createdAsOrganization, createdCountry, createdCity, lastActiveAt
         FROM session WHERE id = ?`,
      )
        .bind(sessionId)
        .first<Record<string, unknown>>();

    const initial = await sessionRow();
    expect(initial?.["createdAsn"]).toBe(45899);

    // Same ASN & country within 15 minutes: does not rewrite lastActiveAt.
    const fixedTime = new Date(Date.now() - 5 * 60_000).toISOString();
    await env.DB.prepare("UPDATE session SET lastActiveAt = ? WHERE id = ?")
      .bind(fixedTime, sessionId)
      .run();
    await call("/v1/me", {
      ...authed(token, { headers: { "cf-connecting-ip": freshIp() } }),
      cf: { asn: 45899, asOrganization: "VNPT Corp", country: "VN", city: "Hanoi" },
    });
    expect((await sessionRow())?.["lastActiveAt"]).toBe(fixedTime);

    // Switching Wi-Fi -> mobile carrier (new ASN) immediately updates current network & lastActiveAt, keeping created* intact.
    const mobileIp = freshIp();
    await call("/v1/me", {
      ...authed(token, { headers: { "cf-connecting-ip": mobileIp } }),
      cf: { asn: 7552, asOrganization: "Viettel Group", country: "VN", city: "Da Nang" },
    });
    const roamed = await sessionRow();
    expect(roamed).toMatchObject({
      ipAddress: mobileIp,
      asn: 7552,
      asOrganization: "Viettel Group",
      country: "VN",
      city: "Da Nang",
      createdIp: originIp,
      createdAsn: 45899,
      createdAsOrganization: "VNPT Corp",
      createdCountry: "VN",
      createdCity: "Hanoi",
    });
    expect(roamed?.["lastActiveAt"]).not.toBe(fixedTime);

    // After > 15 minutes on the same ASN, lastActiveAt also refreshes.
    const staleTime = new Date(Date.now() - 16 * 60_000).toISOString();
    await env.DB.prepare("UPDATE session SET lastActiveAt = ? WHERE id = ?")
      .bind(staleTime, sessionId)
      .run();
    await call("/v1/me", {
      ...authed(token, { headers: { "cf-connecting-ip": mobileIp } }),
      cf: { asn: 7552, asOrganization: "Viettel Group", country: "VN", city: "Da Nang" },
    });
    expect((await sessionRow())?.["lastActiveAt"]).not.toBe(staleTime);
  });

  it("enforces a 15-minute freshAge on passwordless sensitive actions like delete-user", async () => {
    const { userId, token } = await signUpVerified("fresh-age@x.io");
    const staleCreated = new Date(Date.now() - 16 * 60_000).toISOString();
    await env.DB.prepare("UPDATE session SET createdAt = ? WHERE userId = ?")
      .bind(staleCreated, userId)
      .run();
    const res = await call(
      "/api/auth/delete-user",
      authed(token, json({}, { headers: { "cf-connecting-ip": freshIp() } })),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "SESSION_EXPIRED" });
  });
});

/** Computes an RFC 6238 6-digit TOTP code from an otpauth:// URI's base32 secret. */
async function totpFromUri(uri: string, now = Date.now()): Promise<string> {
  const b32 = (new URL(uri).searchParams.get("secret") ?? "").toUpperCase().replace(/=+$/, "");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of b32) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(bytes),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const counter = new ArrayBuffer(8);
  new DataView(counter).setUint32(4, Math.floor(now / 30_000), false);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const code =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    (((mac[offset + 1] ?? 0) & 0xff) << 16) |
    (((mac[offset + 2] ?? 0) & 0xff) << 8) |
    ((mac[offset + 3] ?? 0) & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}

const cookiesOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .filter((pair) => pair && !pair.endsWith("="))
    .join("; ");

describe("2FA audit timestamps, trusted devices, and new-network alerts", () => {
  it("tracks passwordChangedAt, twoFactorEnabledAt, and session twoFactorMethod across TOTP, backup code, and trusted device", async () => {
    const email = "audit-2fa@x.io";
    const { token } = await signUpVerified(email);
    const meBefore = await (await call("/v1/me", authed(token))).json<Record<string, unknown>>();
    expect(typeof meBefore["passwordChangedAt"]).toBe("string");
    expect(meBefore["twoFactorEnabledAt"]).toBeNull();

    const enable = await call(
      "/api/auth/two-factor/enable",
      authed(token, json({ password: PASSWORD }, { headers: { "cf-connecting-ip": freshIp() } })),
    );
    expect(enable.status).toBe(200);
    const { totpURI, backupCodes } = await enable.json<{
      totpURI: string;
      backupCodes: string[];
    }>();
    const confirm = await call(
      "/api/auth/two-factor/verify-totp",
      authed(
        token,
        json({ code: await totpFromUri(totpURI) }, { headers: { "cf-connecting-ip": freshIp() } }),
      ),
    );
    expect(confirm.status).toBe(200);
    const activeToken = confirm.headers.get("set-auth-token") ?? token;
    const meEnabled = await (await call("/v1/me", authed(activeToken))).json<
      Record<string, unknown>
    >();
    expect(typeof meEnabled["twoFactorEnabledAt"]).toBe("string");

    // Sign in with TOTP + trustDevice: true -> stamps twoFactorMethod = "totp" and mints both cookie & mobile token.
    const ip1 = freshIp();
    const challenge1 = await call("/api/auth/sign-in/email", {
      ...json(
        { email, password: PASSWORD },
        { headers: { "cf-connecting-ip": ip1, "user-agent": "MacSafari/18" } },
      ),
      cf: { asn: 45899, asOrganization: "VNPT Corp", country: "VN", city: "Hanoi" },
    });
    expect(await challenge1.json()).toMatchObject({ twoFactorRedirect: true });
    const verifyTotp = await call("/api/auth/two-factor/verify-totp", {
      ...json(
        { code: await totpFromUri(totpURI), trustDevice: true },
        {
          headers: {
            "cf-connecting-ip": ip1,
            "user-agent": "MacSafari/18",
            cookie: cookiesOf(challenge1),
          },
        },
      ),
      cf: { asn: 45899, asOrganization: "VNPT Corp", country: "VN", city: "Hanoi" },
    });
    expect(verifyTotp.status).toBe(200);
    const totpBearer = verifyTotp.headers.get("set-auth-token") ?? "";
    const trustToken = verifyTotp.headers.get("set-trust-device-token") ?? "";
    expect(trustToken.length).toBeGreaterThanOrEqual(40);
    const trustCookies = cookiesOf(verifyTotp);

    const totpSession = await (await call("/api/auth/get-session", authed(totpBearer))).json<{
      session: Record<string, unknown>;
    }>();
    expect(totpSession.session["twoFactorMethod"]).toBe("totp");
    expect(typeof totpSession.session["twoFactorVerifiedAt"]).toBe("string");

    // Mobile header X-Trust-Device-Token skips 2FA with NO cookies and stamps twoFactorMethod = "trusted_device",
    // updating current network while preserving createdIp / createdAsn / createdCountry on the trusted device.
    const ip2 = freshIp();
    const mobileSignIn = await call("/api/auth/sign-in/email", {
      ...json(
        { email, password: PASSWORD },
        {
          headers: {
            "cf-connecting-ip": ip2,
            "user-agent": "EdgeBaseExpo/2.0",
            "x-trust-device-token": trustToken,
          },
        },
      ),
      cf: { asn: 7552, asOrganization: "Viettel Group", country: "VN", city: "Ho Chi Minh City" },
    });
    expect(mobileSignIn.status).toBe(200);
    const mobileBody = await mobileSignIn.json<Record<string, unknown>>();
    expect(mobileBody["twoFactorRedirect"]).toBeUndefined();
    const mobileBearer = mobileSignIn.headers.get("set-auth-token") ?? "";
    const rotatedTrustToken = mobileSignIn.headers.get("set-trust-device-token") ?? "";
    expect(rotatedTrustToken).not.toBe(trustToken);
    const tdSession = await (await call("/api/auth/get-session", authed(mobileBearer))).json<{
      session: Record<string, unknown>;
    }>();
    expect(tdSession.session["twoFactorMethod"]).toBe("trusted_device");
    expect(typeof tdSession.session["twoFactorVerifiedAt"]).toBe("string");

    // GET /v1/trusted-devices lists the device, marking current = true when rotated token matches.
    const listRes = await call(
      "/v1/trusted-devices",
      authed(mobileBearer, { headers: { "x-trust-device-token": rotatedTrustToken } }),
    );
    expect(listRes.status).toBe(200);
    const { devices } = await listRes.json<{ devices: Array<Record<string, unknown>> }>();
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      ipAddress: ip2,
      asn: 7552,
      asOrganization: "Viettel Group",
      country: "VN",
      city: "Ho Chi Minh City",
      createdIp: ip1,
      createdAsn: 45899,
      createdCountry: "VN",
      current: true,
    });
    const deviceId = String(devices[0]?.["id"]);

    // Another user cannot delete this trusted device (404).
    const stranger = await signUpVerified("stranger-td@x.io");
    expect(
      (await call(`/v1/trusted-devices/${deviceId}`, authed(stranger.token, { method: "DELETE" })))
        .status,
    ).toBe(404);

    // Revoking the trusted device in D1 immediately forces 2FA again, EVEN if the browser replays Better Auth's trust_device cookie!
    expect(
      (await call(`/v1/trusted-devices/${deviceId}`, authed(mobileBearer, { method: "DELETE" })))
        .status,
    ).toBe(204);
    const afterRevoke = await call(
      "/api/auth/sign-in/email",
      json(
        { email, password: PASSWORD },
        { headers: { "cf-connecting-ip": freshIp(), cookie: trustCookies } },
      ),
    );
    expect(await afterRevoke.json()).toMatchObject({ twoFactorRedirect: true });

    // Verify with backup code -> stamps twoFactorMethod = "backup_code".
    const verifyBackup = await call(
      "/api/auth/two-factor/verify-backup-code",
      json(
        { code: backupCodes[0], trustDevice: true },
        { headers: { "cf-connecting-ip": freshIp(), cookie: cookiesOf(afterRevoke) } },
      ),
    );
    expect(verifyBackup.status).toBe(200);
    const backupBearer = verifyBackup.headers.get("set-auth-token") ?? "";
    const backupSession = await (await call("/api/auth/get-session", authed(backupBearer))).json<{
      session: Record<string, unknown>;
    }>();
    expect(backupSession.session["twoFactorMethod"]).toBe("backup_code");
  });

  it("wipes trusted devices and other sessions on password change, password reset, and 2FA disable, and caps at 20 devices", async () => {
    const email = "wipe-td@x.io";
    const { userId, token } = await signUpVerified(email);
    const enable = await call(
      "/api/auth/two-factor/enable",
      authed(token, json({ password: PASSWORD }, { headers: { "cf-connecting-ip": freshIp() } })),
    );
    const { totpURI } = await enable.json<{ totpURI: string }>();
    const confirm = await call(
      "/api/auth/two-factor/verify-totp",
      authed(
        token,
        json({ code: await totpFromUri(totpURI) }, { headers: { "cf-connecting-ip": freshIp() } }),
      ),
    );
    const currentToken = confirm.headers.get("set-auth-token") ?? token;

    // Seed 20 existing trusted devices; minting the 21st prunes the oldest last_used_at row.
    for (let i = 1; i <= 20; i++) {
      await env.DB.prepare(
        `INSERT INTO trusted_device (id, token_hash, user_id, created_at, last_used_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(`td-seed-${i}`, `hash-seed-${i}`, userId, i * 1000, i * 1000, Date.now() + 86_400_000)
        .run();
    }
    const ch = await call(
      "/api/auth/sign-in/email",
      json({ email, password: PASSWORD }, { headers: { "cf-connecting-ip": freshIp() } }),
    );
    const verified21 = await call(
      "/api/auth/two-factor/verify-totp",
      json(
        { code: await totpFromUri(totpURI), trustDevice: true },
        { headers: { "cf-connecting-ip": freshIp(), cookie: cookiesOf(ch) } },
      ),
    );
    expect(verified21.status).toBe(200);
    const session21 = verified21.headers.get("set-auth-token") ?? "";
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM trusted_device WHERE user_id = ?")
        .bind(userId)
        .first("n"),
    ).toBe(20);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM trusted_device WHERE id = 'td-seed-1'").first(
        "n",
      ),
    ).toBe(0);

    // Changing password wipes all 20 trusted devices, revokes other sessions, and updates passwordChangedAt.
    const nextPw = "pw-updated-horse-99";
    const beforeChange = await env.DB.prepare("SELECT passwordChangedAt FROM user WHERE id = ?")
      .bind(userId)
      .first<string>("passwordChangedAt");
    await new Promise((r) => setTimeout(r, 5));
    const change = await call(
      "/api/auth/change-password",
      authed(
        session21,
        json(
          { currentPassword: PASSWORD, newPassword: nextPw },
          { headers: { "cf-connecting-ip": freshIp() } },
        ),
      ),
    );
    expect(change.status).toBe(200);
    const afterChangeToken = change.headers.get("set-auth-token") ?? session21;
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM trusted_device WHERE user_id = ?")
        .bind(userId)
        .first("n"),
    ).toBe(0);
    // Earlier session was revoked; current session stays valid.
    expect((await call("/v1/me", authed(currentToken))).status).toBe(401);
    expect((await call("/v1/me", authed(afterChangeToken))).status).toBe(200);
    const afterChange = await env.DB.prepare("SELECT passwordChangedAt FROM user WHERE id = ?")
      .bind(userId)
      .first<string>("passwordChangedAt");
    expect(afterChange).not.toBe(beforeChange);

    // Disabling 2FA clears twoFactorEnabledAt and wipes any trusted devices.
    await env.DB.prepare(
      `INSERT INTO trusted_device (id, token_hash, user_id, created_at, last_used_at, expires_at)
       VALUES ('td-before-disable', 'hash-before-disable', ?, 1, 1, ?)`,
    )
      .bind(userId, Date.now() + 86_400_000)
      .run();
    const disable = await call(
      "/api/auth/two-factor/disable",
      authed(
        afterChangeToken,
        json({ password: nextPw }, { headers: { "cf-connecting-ip": freshIp() } }),
      ),
    );
    expect(disable.status).toBe(200);
    expect(
      await env.DB.prepare("SELECT twoFactorEnabledAt FROM user WHERE id = ?")
        .bind(userId)
        .first("twoFactorEnabledAt"),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM trusted_device WHERE user_id = ?")
        .bind(userId)
        .first("n"),
    ).toBe(0);

    // Expired trusted_device rows are hidden from GET /v1/trusted-devices, and DELETE /v1/trusted-devices revokes all live ones.
    const disableBearer = disable.headers.get("set-auth-token") ?? afterChangeToken;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO trusted_device (id, token_hash, user_id, created_at, last_used_at, expires_at)
         VALUES ('td-expired', 'hash-exp', ?1, 1, 1, ?2), ('td-live-a', 'hash-a', ?1, 2, 2, ?3), ('td-live-b', 'hash-b', ?1, 3, 3, ?3)`,
      ).bind(userId, Date.now() - 1000, Date.now() + 86_400_000),
    ]);
    const listedBeforeClear = await (
      await call("/v1/trusted-devices", authed(disableBearer))
    ).json<{ devices: Array<{ id: string }> }>();
    expect(listedBeforeClear.devices.map((d) => d.id).sort()).toEqual(["td-live-a", "td-live-b"]);
    expect(
      (await call("/v1/trusted-devices", authed(disableBearer, { method: "DELETE" }))).status,
    ).toBe(204);
    expect(
      (
        await (
          await call("/v1/trusted-devices", authed(disableBearer))
        ).json<{
          devices: unknown[];
        }>()
      ).devices,
    ).toHaveLength(0);

    // reset-password wipes trusted_device rows and updates passwordChangedAt.
    await env.DB.prepare(
      `INSERT INTO trusted_device (id, token_hash, user_id, created_at, last_used_at, expires_at)
       VALUES ('td-before-reset', 'hash-before-reset', ?, 1, 1, ?)`,
    )
      .bind(userId, Date.now() + 86_400_000)
      .run();
    let resetToken = "";
    const mailCapture: Env = {
      ...env,
      MAIL: {
        async send(msg: { text: string }) {
          const match = msg.text.match(/reset-password\/([^\s?]+)/);
          resetToken = match?.[1] ?? "";
        },
      } as unknown as SendEmail,
    };
    await call(
      "/api/auth/request-password-reset",
      json(
        { email, redirectTo: "https://web.test/reset" },
        { headers: { "cf-connecting-ip": freshIp() } },
      ),
      mailCapture,
    );
    expect(resetToken.length).toBeGreaterThan(5);
    await new Promise((r) => setTimeout(r, 5));
    const resetRes = await call(
      "/api/auth/reset-password",
      json(
        { token: resetToken, newPassword: "pw-after-reset-horse-77" },
        { headers: { "cf-connecting-ip": freshIp() } },
      ),
    );
    expect(resetRes.status).toBe(200);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM trusted_device WHERE user_id = ?")
        .bind(userId)
        .first("n"),
    ).toBe(0);
    const afterReset = await env.DB.prepare("SELECT passwordChangedAt FROM user WHERE id = ?")
      .bind(userId)
      .first<string>("passwordChangedAt");
    expect(afterReset).not.toBe(afterChange);
  });

  it("alerts via email and personal inbox on sign-in from a new network, never before 2FA completes or on initial sign-up", async () => {
    const sentMail: Array<{ to: string; subject: string; text: string }> = [];
    const bindings: Env = {
      ...env,
      MAIL: {
        async send(msg: { to: string; from: string; subject: string; text: string }) {
          sentMail.push({ to: msg.to, subject: msg.subject, text: msg.text });
        },
      } as unknown as SendEmail,
    };

    const email = "alert-net@x.io";
    const ipHome = freshIp();
    const up = await call(
      "/api/auth/sign-up/email",
      {
        ...json(
          { email, password: PASSWORD, name: "Alert User" },
          { headers: { "cf-connecting-ip": ipHome } },
        ),
        cf: { asn: 45899, asOrganization: "VNPT Corp", country: "VN", city: "Hanoi" },
      },
      bindings,
    );
    const { user } = await up.json<{ user: { id: string } }>();
    await env.DB.prepare("UPDATE user SET emailVerified = 1 WHERE id = ?").bind(user.id).run();
    sentMail.length = 0;

    // First sign-in after verification establishes baseline network -> no security alert.
    const first = await call(
      "/api/auth/sign-in/email",
      {
        ...json({ email, password: PASSWORD }, { headers: { "cf-connecting-ip": ipHome } }),
        cf: { asn: 45899, asOrganization: "VNPT Corp", country: "VN", city: "Hanoi" },
      },
      bindings,
    );
    const homeToken = first.headers.get("set-auth-token") ?? "";
    expect(sentMail).toHaveLength(0);

    // Enable 2FA on the account.
    const enable = await call(
      "/api/auth/two-factor/enable",
      authed(homeToken, json({ password: PASSWORD }, { headers: { "cf-connecting-ip": ipHome } })),
      bindings,
    );
    const { totpURI } = await enable.json<{ totpURI: string }>();
    await call(
      "/api/auth/two-factor/verify-totp",
      authed(
        homeToken,
        json({ code: await totpFromUri(totpURI) }, { headers: { "cf-connecting-ip": ipHome } }),
      ),
      bindings,
    );
    sentMail.length = 0;

    // Password step from a foreign ASN/country stops at twoFactorRedirect -> MUST NOT send alert yet!
    const ipForeign = freshIp();
    const pending = await call(
      "/api/auth/sign-in/email",
      {
        ...json(
          { email, password: PASSWORD },
          { headers: { "cf-connecting-ip": ipForeign, "user-agent": "LinuxChrome/130" } },
        ),
        cf: { asn: 16509, asOrganization: "Amazon.com, Inc.", country: "SG", city: "Singapore" },
      },
      bindings,
    );
    expect(await pending.json()).toMatchObject({ twoFactorRedirect: true });
    expect(sentMail).toHaveLength(0);

    // Completing 2FA from that unfamiliar (ASN, country) dispatches BOTH email and personal inbox alert!
    const completed = await call(
      "/api/auth/two-factor/verify-totp",
      {
        ...json(
          { code: await totpFromUri(totpURI) },
          {
            headers: {
              "cf-connecting-ip": ipForeign,
              "user-agent": "LinuxChrome/130",
              cookie: cookiesOf(pending),
            },
          },
        ),
        cf: { asn: 16509, asOrganization: "Amazon.com, Inc.", country: "SG", city: "Singapore" },
      },
      bindings,
    );
    expect(completed.status).toBe(200);
    const sgToken = completed.headers.get("set-auth-token") ?? "";
    expect(sentMail).toHaveLength(1);
    expect(sentMail[0]?.subject).toMatch(/sign-in/i);
    expect(sentMail[0]?.text).toContain("Amazon.com");
    expect(sentMail[0]?.text).toContain("SG");

    const inbox = await (await call("/v1/inbox", authed(sgToken), bindings)).json<{
      items: Array<{ title: string; body: string; category: string }>;
    }>();
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]).toMatchObject({ category: "transactional" });
    expect(inbox.items[0]?.body).toContain("SG");

    // Another sign-in from the now-known (16509, SG) network does not spam a second alert.
    sentMail.length = 0;
    const pendingAgain = await call(
      "/api/auth/sign-in/email",
      {
        ...json({ email, password: PASSWORD }, { headers: { "cf-connecting-ip": freshIp() } }),
        cf: { asn: 16509, asOrganization: "Amazon.com, Inc.", country: "SG", city: "Singapore" },
      },
      bindings,
    );
    const completedAgain = await call(
      "/api/auth/two-factor/verify-totp",
      {
        ...json(
          { code: await totpFromUri(totpURI) },
          { headers: { "cf-connecting-ip": freshIp(), cookie: cookiesOf(pendingAgain) } },
        ),
        cf: { asn: 16509, asOrganization: "Amazon.com, Inc.", country: "SG", city: "Singapore" },
      },
      bindings,
    );
    expect(completedAgain.status).toBe(200);
    expect(sentMail).toHaveLength(0);
  });
});

describe("security review regressions", () => {
  afterEach(() => vi.restoreAllMocks());

  it("still sends new-network alerts when trustDevice: true is set, sanitizes User-Agent, and recognizes origin createdAsn", async () => {
    const sentMail: Array<{ to: string; subject: string; text: string }> = [];
    const bindings: Env = {
      ...env,
      MAIL: {
        async send(msg: { to: string; from: string; subject: string; text: string }) {
          sentMail.push({ to: msg.to, subject: msg.subject, text: msg.text });
        },
      } as unknown as SendEmail,
    };

    const email = "alert-td-bypass@x.io";
    const ipHome = freshIp();
    const up = await call(
      "/api/auth/sign-up/email",
      {
        ...json(
          { email, password: PASSWORD, name: "Bypass Check" },
          { headers: { "cf-connecting-ip": ipHome } },
        ),
        cf: { asn: 45899, asOrganization: "VNPT Corp", country: "VN", city: "Hanoi" },
      },
      bindings,
    );
    const { user } = await up.json<{ user: { id: string } }>();
    await env.DB.prepare("UPDATE user SET emailVerified = 1 WHERE id = ?").bind(user.id).run();

    const first = await call(
      "/api/auth/sign-in/email",
      {
        ...json({ email, password: PASSWORD }, { headers: { "cf-connecting-ip": ipHome } }),
        cf: { asn: 45899, asOrganization: "VNPT Corp", country: "VN", city: "Hanoi" },
      },
      bindings,
    );
    const homeToken = first.headers.get("set-auth-token") ?? "";
    const enable = await call(
      "/api/auth/two-factor/enable",
      authed(homeToken, json({ password: PASSWORD }, { headers: { "cf-connecting-ip": ipHome } })),
      bindings,
    );
    const { totpURI } = await enable.json<{ totpURI: string }>();
    const confirmed = await call(
      "/api/auth/two-factor/verify-totp",
      {
        ...authed(
          homeToken,
          json({ code: await totpFromUri(totpURI) }, { headers: { "cf-connecting-ip": ipHome } }),
        ),
        cf: { asn: 45899, asOrganization: "VNPT Corp", country: "VN", city: "Hanoi" },
      },
      bindings,
    );
    const activeHomeToken = confirmed.headers.get("set-auth-token") ?? homeToken;

    // Roam the first device onto mobile carrier AS7552 so its current asn is 7552 while createdAsn stays 45899.
    await call(
      "/v1/me",
      {
        ...authed(activeHomeToken, { headers: { "cf-connecting-ip": freshIp() } }),
        cf: { asn: 7552, asOrganization: "Viettel Group", country: "VN", city: "Hanoi" },
      },
      bindings,
    );
    sentMail.length = 0;

    // Signing in on home Wi-Fi (AS45899, VN) matches createdAsn/createdCountry -> no false-positive alert!
    const homeChallenge = await call(
      "/api/auth/sign-in/email",
      {
        ...json({ email, password: PASSWORD }, { headers: { "cf-connecting-ip": freshIp() } }),
        cf: { asn: 45899, asOrganization: "VNPT Corp", country: "VN", city: "Hanoi" },
      },
      bindings,
    );
    const homeVerify = await call(
      "/api/auth/two-factor/verify-totp",
      {
        ...json(
          { code: await totpFromUri(totpURI) },
          { headers: { "cf-connecting-ip": freshIp(), cookie: cookiesOf(homeChallenge) } },
        ),
        cf: { asn: 45899, asOrganization: "VNPT Corp", country: "VN", city: "Hanoi" },
      },
      bindings,
    );
    expect(homeVerify.status).toBe(200);
    expect(sentMail).toHaveLength(0);

    // Foreign login WITH trustDevice: true and malicious User-Agent MUST still alert and sanitize UA!
    const evilUa =
      "BadBot/1.0   Urgent: click https://evil.example/phish\t<script>alert(1)</script>";
    const foreignChallenge = await call(
      "/api/auth/sign-in/email",
      {
        ...json(
          { email, password: PASSWORD },
          { headers: { "cf-connecting-ip": freshIp(), "user-agent": evilUa } },
        ),
        cf: { asn: 14061, asOrganization: "DigitalOcean, LLC", country: "DE", city: "Frankfurt" },
      },
      bindings,
    );
    const foreignVerify = await call(
      "/api/auth/two-factor/verify-totp",
      {
        ...json(
          { code: await totpFromUri(totpURI), trustDevice: true },
          {
            headers: {
              "cf-connecting-ip": freshIp(),
              "user-agent": evilUa,
              cookie: cookiesOf(foreignChallenge),
            },
          },
        ),
        cf: { asn: 14061, asOrganization: "DigitalOcean, LLC", country: "DE", city: "Frankfurt" },
      },
      bindings,
    );
    expect(foreignVerify.status).toBe(200);
    expect(sentMail).toHaveLength(1);
    expect(sentMail[0]?.text).not.toContain("https://evil.example");
    expect(sentMail[0]?.text).not.toContain("<script>");
    expect((sentMail[0]?.text ?? "").length).toBeLessThan(500);
  });

  it("allows listing and revoking sessions via /v1/sessions past 15-minute freshAge without exposing raw tokens", async () => {
    const email = "sessions-v1@x.io";
    const { userId, token: token1 } = await signUpVerified(email);
    const second = await call(
      "/api/auth/sign-in/email",
      json({ email, password: PASSWORD }, { headers: { "cf-connecting-ip": freshIp() } }),
    );
    const token2 = second.headers.get("set-auth-token") ?? "";
    const third = await call(
      "/api/auth/sign-in/email",
      json({ email, password: PASSWORD }, { headers: { "cf-connecting-ip": freshIp() } }),
    );
    const token3 = third.headers.get("set-auth-token") ?? "";

    // Age all sessions past the 15-minute freshAge window.
    const oldIso = new Date(Date.now() - 25 * 60_000).toISOString();
    await env.DB.prepare("UPDATE session SET createdAt = ? WHERE userId = ?")
      .bind(oldIso, userId)
      .run();

    const listRes = await call("/v1/sessions", authed(token1));
    expect(listRes.status).toBe(200);
    const { sessions } = await listRes.json<{ sessions: Array<Record<string, unknown>> }>();
    expect(sessions).toHaveLength(3);
    expect(sessions.filter((s) => s["current"] === true)).toHaveLength(1);
    for (const s of sessions) {
      expect(s["token"]).toBeUndefined();
    }

    // Revoke one specific non-current session by opaque id.
    const other = sessions.find((s) => s["current"] === false);
    expect(
      (await call(`/v1/sessions/${String(other?.["id"])}`, authed(token1, { method: "DELETE" })))
        .status,
    ).toBe(204);

    // Revoke all remaining other sessions while keeping token1 alive.
    expect(
      (await call("/v1/sessions/revoke-others", authed(token1, { method: "POST" }))).status,
    ).toBe(204);
    expect((await call("/v1/me", authed(token1))).status).toBe(200);
    expect((await call("/v1/me", authed(token2))).status).toBe(401);
    expect((await call("/v1/me", authed(token3))).status).toBe(401);

    // Auth & CORS boundary checks on /v1/sessions and /v1/trusted-devices.
    expect((await call("/v1/sessions")).status).toBe(401);
    expect((await call("/v1/trusted-devices")).status).toBe(401);
    expect(
      (await call("/v1/trusted-devices", authed(token1), { ...env, BETTER_AUTH_SECRET: "" }))
        .status,
    ).toBe(503);
    const preflight = await call("/api/auth/sign-in/email", {
      method: "OPTIONS",
      headers: {
        origin: "https://web.test",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,x-trust-device-token",
      },
    });
    expect(preflight.headers.get("access-control-allow-headers")).toContain("x-trust-device-token");
    expect(preflight.headers.get("access-control-expose-headers")).toContain(
      "set-trust-device-token",
    );
  });

  it("preserves signInProvider and origin telemetry on session rotation, guards wrong-password trust touches, and revokes on admin password/ban updates", async () => {
    // 1. GitHub admin who enables and then disables TOTP keeps signInProvider = "github" and stays allowed on /api/auth/admin/*.
    const ghEmail = "gh-rotate-admin@x.io";
    const gh = await githubOAuth(ghEmail);
    const ghMe = await (await call("/api/auth/get-session", gh.session)).json<{
      user: { id: string };
    }>();
    const pwHash = await env.DB.prepare(
      "SELECT password FROM account WHERE password IS NOT NULL LIMIT 1",
    ).first<string>("password");
    const nowIso = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("UPDATE user SET role = 'admin' WHERE id = ?").bind(ghMe.user.id),
      env.DB.prepare(
        "INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES ('acc-gh-pw', ?, 'credential', ?, ?, ?, ?)",
      ).bind(ghMe.user.id, ghMe.user.id, pwHash, nowIso, nowIso),
      env.DB.prepare(
        "UPDATE session SET createdAsn = 45899, createdCountry = 'VN' WHERE userId = ?",
      ).bind(ghMe.user.id),
    ]);

    const enableGh = await call("/api/auth/two-factor/enable", {
      ...json(
        { password: PASSWORD },
        { headers: { ...gh.session.headers, "cf-connecting-ip": freshIp() } },
      ),
      cf: { asn: 7552, country: "SG" },
    });
    const { totpURI } = await enableGh.json<{ totpURI: string }>();
    const verifyGh = await call("/api/auth/two-factor/verify-totp", {
      ...json(
        { code: await totpFromUri(totpURI) },
        { headers: { ...gh.session.headers, "cf-connecting-ip": freshIp() } },
      ),
      cf: { asn: 7552, country: "SG" },
    });
    const rotatedCookie1 = cookiesOf(verifyGh) || gh.session.headers.cookie;
    const disableGh = await call("/api/auth/two-factor/disable", {
      ...json(
        { password: PASSWORD },
        { headers: { cookie: rotatedCookie1, "cf-connecting-ip": freshIp() } },
      ),
      cf: { asn: 7552, country: "SG" },
    });
    expect(disableGh.status).toBe(200);
    const rotatedCookie2 = cookiesOf(disableGh);
    const rotatedSession = await (
      await call("/api/auth/get-session", { headers: { cookie: rotatedCookie2 } })
    ).json<{ session: Record<string, unknown> }>();
    expect(rotatedSession.session).toMatchObject({
      signInProvider: "github",
      createdAsn: 45899,
      createdCountry: "VN",
    });
    expect(
      (await call("/api/auth/admin/list-users", { headers: { cookie: rotatedCookie2 } })).status,
    ).toBe(200);

    // 2. Wrong password on /sign-in/email does not mutate trusted_device.last_used_at or leave trust-device-* rows in verification.
    const tdEmail = "wrong-pw-td@x.io";
    const tdUser = await signUpVerified(tdEmail);
    const en = await call(
      "/api/auth/two-factor/enable",
      authed(
        tdUser.token,
        json({ password: PASSWORD }, { headers: { "cf-connecting-ip": freshIp() } }),
      ),
    );
    const { totpURI: tdUri } = await en.json<{ totpURI: string }>();
    await call(
      "/api/auth/two-factor/verify-totp",
      authed(
        tdUser.token,
        json({ code: await totpFromUri(tdUri) }, { headers: { "cf-connecting-ip": freshIp() } }),
      ),
    );
    const ch = await call(
      "/api/auth/sign-in/email",
      json({ email: tdEmail, password: PASSWORD }, { headers: { "cf-connecting-ip": freshIp() } }),
    );
    const minted = await call("/api/auth/two-factor/verify-totp", {
      ...json(
        { code: await totpFromUri(tdUri), trustDevice: true },
        { headers: { "cf-connecting-ip": "203.0.113.10", cookie: cookiesOf(ch) } },
      ),
      cf: { asn: 45899, country: "VN" },
    });
    const rawTd = minted.headers.get("set-trust-device-token") ?? "";
    const fixedLastUsed = Date.now() - 3_600_000;
    await env.DB.prepare("UPDATE trusted_device SET last_used_at = ? WHERE user_id = ?")
      .bind(fixedLastUsed, tdUser.userId)
      .run();

    const wrongPw = await call("/api/auth/sign-in/email", {
      ...json(
        { email: tdEmail, password: "wrong-password-attempt" },
        { headers: { "cf-connecting-ip": "198.51.100.99", "x-trust-device-token": rawTd } },
      ),
      cf: { asn: 16509, country: "US" },
    });
    expect(wrongPw.status).toBe(401);
    const tdAfterWrong = await env.DB.prepare(
      "SELECT last_used_at, ip_address, asn, country FROM trusted_device WHERE user_id = ?",
    )
      .bind(tdUser.userId)
      .first<Record<string, unknown>>();
    expect(tdAfterWrong).toMatchObject({
      last_used_at: fixedLastUsed,
      ip_address: "203.0.113.10",
      asn: 45899,
      country: "VN",
    });
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM verification WHERE identifier LIKE 'trust-device-%' AND value = ?",
      )
        .bind(tdUser.userId)
        .first("n"),
    ).toBe(0);

    // 3. Admin /admin/set-user-password stamps passwordChangedAt & revokes sessions + trusted devices;
    //    Admin /admin/update-user { banned: true } also revokes trusted devices.
    const setPw = await call("/api/auth/admin/set-user-password", {
      ...json(
        { userId: tdUser.userId, newPassword: "pw-admin-reset-horse-55" },
        { headers: { cookie: rotatedCookie2, "cf-connecting-ip": freshIp() } },
      ),
    });
    expect(setPw.status).toBe(200);
    expect((await call("/v1/me", authed(tdUser.token))).status).toBe(401);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM trusted_device WHERE user_id = ?")
        .bind(tdUser.userId)
        .first("n"),
    ).toBe(0);

    await env.DB.prepare(
      `INSERT INTO trusted_device (id, token_hash, user_id, created_at, last_used_at, expires_at)
       VALUES ('td-update-ban', 'hash-update-ban', ?, 1, 1, ?)`,
    )
      .bind(tdUser.userId, Date.now() + 86_400_000)
      .run();
    const updateBan = await call("/api/auth/admin/update-user", {
      ...json(
        { userId: tdUser.userId, data: { banned: true } },
        { headers: { cookie: rotatedCookie2, "cf-connecting-ip": freshIp() } },
      ),
    });
    expect(updateBan.status).toBe(200);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM trusted_device WHERE user_id = ?")
        .bind(tdUser.userId)
        .first("n"),
    ).toBe(0);
  });
});

describe("audit hardening: token isolation, CSRF, body/column/session/alert lifecycle bounds", () => {
  it("blocks raw token session-list endpoints and serves token-free active-only /v1/admin/users/:userId/sessions", async () => {
    const admin = await signUpVerified("sec-admin@x.io");
    await env.DB.prepare("UPDATE user SET role = 'admin', twoFactorEnabled = 1 WHERE id = ?")
      .bind(admin.userId)
      .run();
    const coAdmin = await signUpVerified("co-admin@x.io");
    await env.DB.prepare("UPDATE user SET role = 'admin', twoFactorEnabled = 1 WHERE id = ?")
      .bind(coAdmin.userId)
      .run();
    // Seed an expired session on coAdmin to ensure admin listing filters it out.
    const pastIso = new Date(Date.now() - 60_000).toISOString();
    await env.DB.prepare(
      "INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, userId) VALUES ('s-exp-co', ?, 'tok-exp-co', ?, ?, ?)",
    )
      .bind(pastIso, pastIso, pastIso, coAdmin.userId)
      .run();
    await env.DB.prepare(
      `INSERT INTO trusted_device (id, token_hash, user_id, created_at, last_used_at, expires_at)
       VALUES ('td-co', 'hash-co', ?, 1, 1, ?)`,
    )
      .bind(coAdmin.userId, Date.now() + 86_400_000)
      .run();

    // Raw-token endpoints are blocked with 404.
    expect((await call("/api/auth/list-sessions", authed(admin.token))).status).toBe(404);
    expect(
      (
        await call(
          "/api/auth/admin/list-user-sessions",
          authed(admin.token, json({ userId: coAdmin.userId })),
        )
      ).status,
    ).toBe(404);

    // Non-admin is refused on /v1/admin/*.
    const plain = await signUpVerified("plain-sec@x.io");
    expect(
      (await call(`/v1/admin/users/${coAdmin.userId}/sessions`, authed(plain.token))).status,
    ).toBe(403);

    // Admin sees active sessions only, with NO raw token exposed.
    const res = await call(`/v1/admin/users/${coAdmin.userId}/sessions`, authed(admin.token));
    expect(res.status).toBe(200);
    const { sessions } = await res.json<{ sessions: Array<Record<string, unknown>> }>();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.["token"]).toBeUndefined();

    // Revoke all sessions of coAdmin via /v1/admin/users/:id/sessions also wipes trusted_device!
    expect(
      (
        await call(
          `/v1/admin/users/${coAdmin.userId}/sessions`,
          authed(admin.token, { method: "DELETE" }),
        )
      ).status,
    ).toBe(204);
    expect((await call("/v1/me", authed(coAdmin.token))).status).toBe(401);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM trusted_device WHERE user_id = ?")
        .bind(coAdmin.userId)
        .first("n"),
    ).toBe(0);
  });

  it("enforces Origin on cookie-authenticated /v1/* mutations and Content-Type: application/json in parseBody", async () => {
    const email = "csrf-cookie@x.io";
    await signUpVerified(email);
    const signIn = await call(
      "/api/auth/sign-in/email",
      json({ email, password: PASSWORD }, { headers: { "cf-connecting-ip": freshIp() } }),
    );
    const cookie = cookiesOf(signIn);
    const activeBearer = signIn.headers.get("set-auth-token") ?? "";

    // Untrusted sibling subdomain or missing Origin on cookie-authed POST -> 403 forbidden_origin.
    expect(
      (
        await call("/v1/sessions/revoke-others", {
          method: "POST",
          headers: { cookie, origin: "https://untrusted.api.test" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await call("/v1/sessions/revoke-others", { method: "POST", headers: { cookie } })).status,
    ).toBe(403);

    // Trusted web origin succeeds -> 204.
    expect(
      (
        await call("/v1/sessions/revoke-others", {
          method: "POST",
          headers: { cookie, origin: "https://web.test" },
        })
      ).status,
    ).toBe(204);

    // text/plain JSON smuggling rejected by parseBody with 400.
    const smuggled = await call("/v1/devices", {
      method: "PUT",
      headers: {
        authorization: `Bearer ${activeBearer}`,
        "content-type": "text/plain",
      },
      body: JSON.stringify({ token: "fcm-smuggle", platform: "ios" }),
    });
    expect(smuggled.status).toBe(400);
  });

  it("enforces 64 KB body limit, user/org column caps, 30-session per-user cap, and 3/hour security alert cap", async () => {
    const email = "lifecycle-caps@x.io";
    const { userId, token } = await signUpVerified(email);

    // 1. >64 KB request body -> 413 payload_too_large.
    const huge = "x".repeat(70 * 1024);
    const tooBig = await call(
      "/v1/devices",
      authed(token, json({ token: huge, platform: "ios" }, { method: "PUT" })),
    );
    expect(tooBig.status).toBe(413);

    // 2. Oversized user.name or organization.name rejected (400).
    const badName = await call(
      "/api/auth/update-user",
      authed(token, json({ name: "n".repeat(200) })),
    );
    expect(badName.status).toBe(400);
    const badOrg = await call(
      "/api/auth/organization/create",
      authed(token, json({ name: "o".repeat(200), slug: "valid-slug" })),
    );
    expect(badOrg.status).toBe(400);

    // 3. Seed 30 sessions for the user; signing in once more caps total sessions at 30 and evicts the oldest.
    const nowMs = Date.now();
    const expIso = new Date(nowMs + 86_400_000).toISOString();
    await env.DB.prepare("DELETE FROM session WHERE userId = ?").bind(userId).run();
    for (let i = 1; i <= 30; i++) {
      const ts = new Date(nowMs - (40 - i) * 60_000).toISOString();
      await env.DB.prepare(
        `INSERT INTO session (id, expiresAt, token, createdAt, updatedAt, lastActiveAt, userId, asn, country)
         VALUES (?, ?, ?, ?, ?, ?, ?, 45899, 'VN')`,
      )
        .bind(`s-cap-${i}`, expIso, `tok-cap-${i}`, ts, ts, ts, userId)
        .run();
    }

    const sentMail: string[] = [];
    const bindings: Env = {
      ...env,
      MAIL: {
        async send(msg: { subject: string }) {
          sentMail.push(msg.subject);
        },
      } as unknown as SendEmail,
    };

    // 4. Sign in from 5 distinct unfamiliar (ASN, country) networks:
    //    - Active sessions stay capped at <= 30 (oldest s-cap-1 evicted)
    //    - Security alerts are rate-capped at 3 within the hour!
    const foreignNets = [
      { asn: 16509, country: "US" },
      { asn: 14061, country: "DE" },
      { asn: 24940, country: "FI" },
      { asn: 13335, country: "JP" },
      { asn: 15169, country: "AU" },
    ];
    for (const net of foreignNets) {
      const res = await call(
        "/api/auth/sign-in/email",
        {
          ...json({ email, password: PASSWORD }, { headers: { "cf-connecting-ip": freshIp() } }),
          cf: net,
        },
        bindings,
      );
      expect(res.status).toBe(200);
    }

    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM session WHERE userId = ?")
        .bind(userId)
        .first("n"),
    ).toBe(30);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM session WHERE id = 's-cap-1'").first("n"),
    ).toBe(0);
    expect(sentMail).toHaveLength(3);
    expect(
      await env.INBOX_DB.prepare("SELECT count(*) AS n FROM inbox_item WHERE user_id = ?")
        .bind(userId)
        .first("n"),
    ).toBe(3);
  });

  it("rotates trusted_device token on use (preserving 30d expiry) and refuses 2FA bypass on country or OS-family shift", async () => {
    const email = "adaptive-td@x.io";
    const macUa = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36";
    const linuxUa = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36";
    const { userId, token } = await signUpVerified(email);

    const enableRes = await call(
      "/api/auth/two-factor/enable",
      authed(token, json({ password: PASSWORD })),
    );
    const { totpURI } = await enableRes.json<{ totpURI: string }>();
    expect(
      (
        await call(
          "/api/auth/two-factor/verify-totp",
          authed(token, json({ code: await totpFromUri(totpURI) })),
        )
      ).status,
    ).toBe(200);

    // Mint initial trusted device on macOS in VN.
    const ch1 = await call("/api/auth/sign-in/email", {
      ...json(
        { email, password: PASSWORD },
        { headers: { "cf-connecting-ip": freshIp(), "user-agent": macUa } },
      ),
      cf: { asn: 45899, asOrganization: "VNPT", country: "VN", city: "Hanoi" },
    });
    const verify1 = await call("/api/auth/two-factor/verify-totp", {
      ...json(
        { code: await totpFromUri(totpURI), trustDevice: true },
        {
          headers: {
            "cf-connecting-ip": freshIp(),
            "user-agent": macUa,
            cookie: cookiesOf(ch1),
          },
        },
      ),
      cf: { asn: 45899, asOrganization: "VNPT", country: "VN", city: "Hanoi" },
    });
    expect(verify1.status).toBe(200);
    const trustToken1 = verify1.headers.get("set-trust-device-token") ?? "";
    expect(trustToken1.length).toBeGreaterThan(30);

    const origExp = await env.DB.prepare("SELECT expires_at FROM trusted_device WHERE user_id = ?")
      .bind(userId)
      .first<number>("expires_at");
    expect(origExp).toBeTypeOf("number");

    // 1. Country shift (VN -> DE) on same OS -> MUST refuse 2FA bypass!
    const countryShift = await call("/api/auth/sign-in/email", {
      ...json(
        { email, password: PASSWORD },
        {
          headers: {
            "cf-connecting-ip": freshIp(),
            "user-agent": macUa,
            "x-trust-device-token": trustToken1,
          },
        },
      ),
      cf: { asn: 14061, asOrganization: "DigitalOcean", country: "DE", city: "Frankfurt" },
    });
    expect(countryShift.status).toBe(200);
    expect(await countryShift.json()).toMatchObject({ twoFactorRedirect: true });

    // 2. OS-family shift (macOS -> Linux) in same country -> MUST refuse 2FA bypass!
    const osShift = await call("/api/auth/sign-in/email", {
      ...json(
        { email, password: PASSWORD },
        {
          headers: {
            "cf-connecting-ip": freshIp(),
            "user-agent": linuxUa,
            "x-trust-device-token": trustToken1,
          },
        },
      ),
      cf: { asn: 45899, asOrganization: "VNPT", country: "VN", city: "Hanoi" },
    });
    expect(osShift.status).toBe(200);
    expect(await osShift.json()).toMatchObject({ twoFactorRedirect: true });

    // 3. Legitimate mobile/ISP roam within VN on macOS -> bypasses 2FA AND rotates token while keeping origExp!
    const validRoam = await call("/api/auth/sign-in/email", {
      ...json(
        { email, password: PASSWORD },
        {
          headers: {
            "cf-connecting-ip": freshIp(),
            "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36",
            "x-trust-device-token": trustToken1,
          },
        },
      ),
      cf: { asn: 7552, asOrganization: "Viettel Group", country: "VN", city: "Da Nang" },
    });
    expect(validRoam.status).toBe(200);
    const roamBody = await validRoam.json<{ twoFactorRedirect?: boolean; user?: { id: string } }>();
    expect(roamBody.twoFactorRedirect).toBeUndefined();
    expect(roamBody.user?.id).toBe(userId);

    const trustToken2 = validRoam.headers.get("set-trust-device-token") ?? "";
    expect(trustToken2.length).toBeGreaterThan(30);
    expect(trustToken2).not.toBe(trustToken1);
    expect(cookiesOf(validRoam)).toContain(encodeURIComponent(trustToken2));

    const afterExp = await env.DB.prepare("SELECT expires_at FROM trusted_device WHERE user_id = ?")
      .bind(userId)
      .first<number>("expires_at");
    expect(afterExp).toBe(origExp);

    // 4. Replaying old trustToken1 now fails to bypass 2FA, while trustToken2 works!
    const replayOld = await call("/api/auth/sign-in/email", {
      ...json(
        { email, password: PASSWORD },
        {
          headers: {
            "cf-connecting-ip": freshIp(),
            "user-agent": macUa,
            "x-trust-device-token": trustToken1,
          },
        },
      ),
      cf: { asn: 7552, asOrganization: "Viettel Group", country: "VN", city: "Da Nang" },
    });
    expect(await replayOld.json()).toMatchObject({ twoFactorRedirect: true });

    const useRotated = await call("/api/auth/sign-in/email", {
      ...json(
        { email, password: PASSWORD },
        {
          headers: {
            "cf-connecting-ip": freshIp(),
            "user-agent": macUa,
            "x-trust-device-token": trustToken2,
          },
        },
      ),
      cf: { asn: 7552, asOrganization: "Viettel Group", country: "VN", city: "Da Nang" },
    });
    expect((await useRotated.json<{ user?: { id: string } }>()).user?.id).toBe(userId);
  });
});

describe("passkeys (WebAuthn / FIDO2)", () => {
  it("registers a UV-required passkey, notifies user, lists/renames/deletes, signs in passwordlessly, and rejects UV=false", async () => {
    const email = "pk-user@x.io";
    const sentMail: Array<{ subject: string; text: string }> = [];
    const bindings: Env = {
      ...env,
      MAIL: {
        async send(msg: { subject: string; text: string }) {
          sentMail.push(msg);
        },
      } as unknown as SendEmail,
    };

    const { userId, token } = await signUpVerified(email);

    // 1. Generate registration options & reject UV=false authenticator.
    const optsRes1 = await call(
      "/api/auth/passkey/generate-register-options",
      authed(token, { headers: { "cf-connecting-ip": freshIp() } }),
      bindings,
    );
    expect(optsRes1.status).toBe(200);
    const opts1 = await optsRes1.json<{ challenge: string; rp: { id: string } }>();
    const challengeCookie1 = cookiesOf(optsRes1);

    const noUv = await createVirtualPasskey({
      challenge: opts1.challenge,
      origin: "https://api.test",
      rpId: opts1.rp.id,
      userVerified: false,
    });
    const badVerify = await call(
      "/api/auth/passkey/verify-registration",
      authed(
        token,
        json(
          { response: noUv.registrationResponse, name: "No UV Key" },
          { headers: { "cf-connecting-ip": freshIp(), cookie: challengeCookie1 } },
        ),
      ),
      bindings,
    );
    expect(badVerify.status).toBe(400);

    // 2. Register a valid UV=true passkey -> succeeds + sends security alert!
    const optsRes2 = await call(
      "/api/auth/passkey/generate-register-options",
      authed(token, { headers: { "cf-connecting-ip": freshIp() } }),
      bindings,
    );
    const opts2 = await optsRes2.json<{ challenge: string; rp: { id: string } }>();
    const challengeCookie2 = cookiesOf(optsRes2);

    const { registrationResponse, authenticator } = await createVirtualPasskey({
      challenge: opts2.challenge,
      origin: "https://api.test",
      rpId: opts2.rp.id,
      userVerified: true,
    });
    const regRes = await call(
      "/api/auth/passkey/verify-registration",
      authed(
        token,
        json(
          { response: registrationResponse, name: "MacBook TouchID", createSession: true },
          { headers: { "cf-connecting-ip": freshIp(), cookie: challengeCookie2 } },
        ),
      ),
      bindings,
    );
    expect(regRes.status).toBe(200);
    const regBody = await regRes.json<{ id: string; name: string; session?: unknown }>();
    expect(regBody.name).toBe("MacBook TouchID");
    // `createSession` stripped so D1 never runs interactive transactions.
    expect(regBody.session).toBeUndefined();
    expect(sentMail.some((m) => /passkey/i.test(m.subject))).toBe(true);

    // 3. List and rename passkey (rejecting >64 char names, and never leaking raw publicKey/credentialID).
    const listRes = await call("/api/auth/passkey/list-user-passkeys", authed(token), bindings);
    expect(listRes.status).toBe(200);
    const listed = await listRes.json<Array<Record<string, unknown>>>();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.["publicKey"]).toBeUndefined();
    expect(listed[0]?.["credentialID"]).toBeUndefined();
    const passkeyId = String(listed[0]?.["id"] ?? "");

    expect(
      (
        await call(
          "/api/auth/passkey/update-passkey",
          authed(token, json({ id: passkeyId, name: "x".repeat(80) })),
          bindings,
        )
      ).status,
    ).toBe(400);

    expect(
      (
        await call(
          "/api/auth/passkey/update-passkey",
          authed(token, json({ id: passkeyId, name: "Work MacBook" })),
          bindings,
        )
      ).status,
    ).toBe(200);

    // 4. Sign in passwordlessly with the passkey -> stamps signInProvider = "passkey" + twoFactorVerifiedAt, increments counter, and rejects UV=false assertion!
    const authOptsRes1 = await call(
      "/api/auth/passkey/generate-authenticate-options",
      { headers: { "cf-connecting-ip": freshIp() } },
      bindings,
    );
    expect(authOptsRes1.status).toBe(200);
    const authOpts1 = await authOptsRes1.json<{ challenge: string; rpId: string }>();
    const authCookie1 = cookiesOf(authOptsRes1);

    const noUvAssertion = await authenticator.sign({
      challenge: authOpts1.challenge,
      origin: "https://api.test",
      rpId: authOpts1.rpId,
      userVerified: false,
    });
    const badAuth = await call(
      "/api/auth/passkey/verify-authentication",
      json(
        { response: noUvAssertion },
        { headers: { "cf-connecting-ip": freshIp(), cookie: authCookie1 } },
      ),
      bindings,
    );
    expect(badAuth.status).toBeGreaterThanOrEqual(400);

    const authOptsRes2 = await call(
      "/api/auth/passkey/generate-authenticate-options",
      { headers: { "cf-connecting-ip": freshIp() } },
      bindings,
    );
    const authOpts2 = await authOptsRes2.json<{ challenge: string; rpId: string }>();
    const authCookie2 = cookiesOf(authOptsRes2);
    const validAssertion = await authenticator.sign({
      challenge: authOpts2.challenge,
      origin: "https://api.test",
      rpId: authOpts2.rpId,
      userVerified: true,
      counter: 2,
    });
    const authRes = await call(
      "/api/auth/passkey/verify-authentication",
      {
        ...json(
          { response: validAssertion },
          { headers: { "cf-connecting-ip": freshIp(), cookie: authCookie2 } },
        ),
        cf: { asn: 45899, asOrganization: "VNPT", country: "VN", city: "Hanoi" },
      },
      bindings,
    );
    expect(authRes.status).toBe(200);
    const pkBearer = authRes.headers.get("set-auth-token") ?? "";
    expect(pkBearer.length).toBeGreaterThan(10);

    const pkSess = await (await call("/api/auth/get-session", authed(pkBearer), bindings)).json<{
      session: Record<string, unknown>;
      user: { id: string };
    }>();
    expect(pkSess.user.id).toBe(userId);
    expect(pkSess.session["signInProvider"]).toBe("passkey");
    expect(typeof pkSess.session["twoFactorVerifiedAt"]).toBe("string");

    expect(
      await env.DB.prepare("SELECT counter FROM passkey WHERE id = ?")
        .bind(passkeyId)
        .first("counter"),
    ).toBe(2);

    // 5. Delete passkey succeeds on fresh session.
    expect(
      (
        await call(
          "/api/auth/passkey/delete-passkey",
          authed(pkBearer, json({ id: passkeyId })),
          bindings,
        )
      ).status,
    ).toBe(200);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM passkey WHERE userId = ?")
        .bind(userId)
        .first("n"),
    ).toBe(0);
  });

  it("unlocks bootstrap admin on first passkey enrollment, blocks password-only admin from adding a 2nd rogue passkey, and enforces freshAge + 20-passkey cap + ban + rate limit", async () => {
    const email = "pk-admin@x.io";
    const { userId, token: firstPwToken } = await signUpVerified(email);
    await env.DB.prepare("UPDATE user SET role = 'admin' WHERE id = ?").bind(userId).run();

    // Un-enrolled password session needs 2FA (cannot hit /api/auth/admin/list-users yet).
    expect((await call("/api/auth/admin/list-users", authed(firstPwToken))).status).toBe(403);
    const meBefore = await (await call("/v1/me", authed(firstPwToken))).json<{
      adminNeedsTwoFactor: boolean;
    }>();
    expect(meBefore.adminNeedsTwoFactor).toBe(true);

    // Bootstrap admin has 0 passkeys -> CAN enroll their FIRST passkey, which upgrades the current session!
    const genRes = await call(
      "/api/auth/passkey/generate-register-options",
      authed(firstPwToken, { headers: { "cf-connecting-ip": freshIp() } }),
    );
    expect(genRes.status).toBe(200);
    const genOpts = await genRes.json<{ challenge: string; rp: { id: string } }>();
    const { registrationResponse, authenticator } = await createVirtualPasskey({
      challenge: genOpts.challenge,
      origin: "https://api.test",
      rpId: genOpts.rp.id,
    });
    const verifyRes = await call(
      "/api/auth/passkey/verify-registration",
      authed(
        firstPwToken,
        json(
          { response: registrationResponse, name: "Admin YubiKey" },
          { headers: { "cf-connecting-ip": freshIp(), cookie: cookiesOf(genRes) } },
        ),
      ),
    );
    expect(verifyRes.status).toBe(200);

    // Current session is immediately upgraded (signInProvider = 'passkey') -> admin routes unlock!
    const meAfter = await (await call("/v1/me", authed(firstPwToken))).json<{
      adminNeedsTwoFactor: boolean;
    }>();
    expect(meAfter.adminNeedsTwoFactor).toBe(false);
    expect((await call("/api/auth/admin/list-users", authed(firstPwToken))).status).toBe(200);

    // CRITICAL GUARD: Attacker steals admin's password and signs in via /sign-in/email.
    // Because admin already has >= 1 passkey (and twoFactorEnabled = false):
    //   1) Plain password session is blocked from /api/auth/admin/* (403)
    //   2) Plain password session CANNOT register a 2nd rogue passkey (403)!
    const leakedSignIn = await call(
      "/api/auth/sign-in/email",
      json({ email, password: PASSWORD }, { headers: { "cf-connecting-ip": freshIp() } }),
    );
    const leakedPwToken = leakedSignIn.headers.get("set-auth-token") ?? "";
    const unsignedLeakedToken = (await leakedSignIn.json<{ token: string }>()).token;
    expect((await call("/api/auth/admin/list-users", authed(leakedPwToken))).status).toBe(403);
    expect(
      (
        await call(
          "/api/auth/passkey/generate-register-options",
          authed(leakedPwToken, { headers: { "cf-connecting-ip": freshIp() } }),
        )
      ).status,
    ).toBe(403);
    // [C-1] & [I-3]: Unsigned raw Bearer token from JSON body MUST NOT bypass hooks.before guards!
    expect(
      (
        await call(
          "/api/auth/passkey/generate-register-options",
          authed(unsignedLeakedToken, { headers: { "cf-connecting-ip": freshIp() } }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await call("/api/auth/passkey/list-user-passkeys", authed(unsignedLeakedToken))).status,
    ).toBe(403);

    // [I-2]: Password-backed admin with twoFactorEnabled=false cannot delete their ONLY passkey (400 LAST_ADMIN_FACTOR).
    const pkId =
      (await env.DB.prepare("SELECT id FROM passkey WHERE userId = ?")
        .bind(userId)
        .first<string>("id")) ?? "";
    expect(
      (await call("/api/auth/passkey/delete-passkey", authed(firstPwToken, json({ id: pkId }))))
        .status,
    ).toBe(400);

    // Stale session (>15m freshAge) cannot rename or delete passkeys — even with unsigned bearer!
    const staleIso = new Date(Date.now() - 20 * 60_000).toISOString();
    await env.DB.prepare("UPDATE session SET createdAt = ? WHERE userId = ?")
      .bind(staleIso, userId)
      .run();
    const unsignedStaleToken = firstPwToken.split(".")[0] ?? "";
    expect(
      (
        await call(
          "/api/auth/passkey/update-passkey",
          authed(unsignedStaleToken, json({ id: pkId, name: "Stale Rename" })),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          "/api/auth/passkey/delete-passkey",
          authed(unsignedStaleToken, json({ id: pkId })),
        )
      ).status,
    ).toBe(403);

    // Sign in freshly with Passkey -> succeeds and reaches /api/auth/admin/list-users!
    const authGen = await call("/api/auth/passkey/generate-authenticate-options", {
      headers: { "cf-connecting-ip": freshIp() },
    });
    const authOpts = await authGen.json<{ challenge: string; rpId: string }>();
    const assertion = await authenticator.sign({
      challenge: authOpts.challenge,
      origin: "https://api.test",
      rpId: authOpts.rpId,
    });
    const pkLogin = await call(
      "/api/auth/passkey/verify-authentication",
      json(
        { response: assertion },
        { headers: { "cf-connecting-ip": freshIp(), cookie: cookiesOf(authGen) } },
      ),
    );
    expect(pkLogin.status).toBe(200);
    const freshPkToken = pkLogin.headers.get("set-auth-token") ?? "";
    expect((await call("/api/auth/admin/list-users", authed(freshPkToken))).status).toBe(200);

    // 20-passkey per-user anti-bloat cap: seed 19 more passkeys (total 20) -> 21st registration refused (400).
    for (let i = 2; i <= 20; i++) {
      await env.DB.prepare(
        `INSERT INTO passkey (id, name, publicKey, userId, credentialID, counter, deviceType, backedUp, createdAt)
         VALUES (?, ?, 'pub', ?, ?, 0, 'singleDevice', 0, ?)`,
      )
        .bind(`pk-cap-${i}`, `Key ${i}`, userId, `cred-cap-${i}`, new Date().toISOString())
        .run();
    }
    expect(
      (
        await call(
          "/api/auth/passkey/generate-register-options",
          authed(freshPkToken, { headers: { "cf-connecting-ip": freshIp() } }),
        )
      ).status,
    ).toBe(400);

    // Banned user is rejected on Passkey authentication (403 BANNED_USER).
    await env.DB.prepare("UPDATE user SET banned = 1 WHERE id = ?").bind(userId).run();
    const banGen = await call("/api/auth/passkey/generate-authenticate-options", {
      headers: { "cf-connecting-ip": freshIp() },
    });
    const banOpts = await banGen.json<{ challenge: string; rpId: string }>();
    const banAssertion = await authenticator.sign({
      challenge: banOpts.challenge,
      origin: "https://api.test",
      rpId: banOpts.rpId,
    });
    const banLogin = await call(
      "/api/auth/passkey/verify-authentication",
      json(
        { response: banAssertion },
        { headers: { "cf-connecting-ip": freshIp(), cookie: cookiesOf(banGen) } },
      ),
    );
    expect(banLogin.status).toBe(403);

    // Rate limit (AUTH_RL) guards GET /api/auth/passkey/generate-authenticate-options against verification table spam.
    const rlIp = freshIp();
    const limited = await firstLimited(() =>
      call("/api/auth/passkey/generate-authenticate-options", {
        headers: { "cf-connecting-ip": rlIp },
      }),
    );
    expect(limited?.status).toBe(429);
  });
});
