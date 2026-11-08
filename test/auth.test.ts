import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
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
    const challengeOf = async (verifier: string) => {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
      return btoa(String.fromCharCode(...new Uint8Array(digest)))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
    };
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
