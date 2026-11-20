import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import { USER_ROLE } from "../src/auth/queries";
import { metered, otherName } from "../src/db/metrics";
import { INBOX_WATERMARK } from "../src/inbox/queries";
import { authed, BASE, freshIp, json, PASSWORD, seedUser, signUpVerified } from "./helpers";

type Logged = { event: string; via: string; path?: string; queries: Record<string, Totals> };
type Totals = { calls: number; rowsRead: number; rowsWritten: number; ms: number };

afterEach(() => vi.restoreAllMocks());

/** Runs `work` measured and returns what it logged. */
async function measure<R>(work: (e: Env) => Promise<R>, path?: string) {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const result = await metered(env, true, { via: "test", ...(path && { path }) }, work);
  const logged = info.mock.calls.map((c) => c[0] as Logged).filter((l) => l.event === "d1");
  return { result, logged };
}

describe("D1 metrics", () => {
  /** A seeded user with a role, which seedUser leaves unset. */
  const userWithRole = async () => {
    const id = await seedUser();
    await env.DB.prepare("UPDATE user SET role = 'user' WHERE id = ?").bind(id).run();
    return id;
  };

  it("names registered statements and adds up their calls and rows", async () => {
    const id = await userWithRole();
    const { result, logged } = await measure(async (e) => {
      const role = await e.DB.prepare(USER_ROLE).bind(id).first<string>("role");
      await e.DB.prepare(USER_ROLE).bind("nobody").first();
      await e.INBOX_DB.batch([e.INBOX_DB.prepare(INBOX_WATERMARK).bind(id)]);
      return role;
    });
    expect(result).toBe("user");
    expect(logged).toHaveLength(1);
    const q = logged[0]?.queries ?? {};
    expect(q["auth.user.role"]).toMatchObject({ calls: 2, rowsWritten: 0 });
    expect(q["auth.user.role"]?.rowsRead).toBeGreaterThanOrEqual(1);
    expect(q["inbox.watermark"]).toMatchObject({ calls: 1 });
  });

  it("keeps first() as it was: the row, a column, null, or a missing-column error", async () => {
    const id = await userWithRole();
    await measure(async (e) => {
      expect(await e.DB.prepare(USER_ROLE).bind(id).first()).toEqual({ role: "user" });
      expect(await e.DB.prepare(USER_ROLE).bind(id).first("role")).toBe("user");
      expect(await e.DB.prepare(USER_ROLE).bind("nobody").first("role")).toBeNull();
      await expect(e.DB.prepare(USER_ROLE).bind(id).first("nope")).rejects.toThrow(
        /D1_COLUMN_NOTFOUND/,
      );
    });
  });

  it("names unregistered SQL by verb and table", () => {
    expect(otherName('SELECT * FROM "session" WHERE token = ?')).toBe("other:select.session");
    expect(otherName("insert into user (id) values (?)")).toBe("other:insert.user");
    expect(otherName("UPDATE account SET x = 1")).toBe("other:update.account");
    expect(otherName("PRAGMA foo")).toBe("other:pragma");
  });

  it("measures a whole request, Better Auth's queries included", async () => {
    const { token } = await signUpVerified("metrics-me@example.com");
    const { result, logged } = await measure(async (e) => {
      const ctx = createExecutionContext();
      const res = await app.fetch(new Request(`${BASE}/v1/me`, authed(token)), e, ctx);
      await waitOnExecutionContext(ctx);
      return res.status;
    }, "/v1/me");
    expect(result).toBe(200);
    expect(logged[0]?.path).toBe("/v1/me");
    const names = Object.keys(logged[0]?.queries ?? {});
    expect(names.some((n) => n.startsWith("other:select.session"))).toBe(true);
  });

  it("does not change what sign-up, sign-in and sync do when measured", async () => {
    const email = "metrics-flow@example.com";
    const headers = { "cf-connecting-ip": freshIp() };
    const { logged } = await measure(async (e) => {
      const send = async (path: string, init: RequestInit) => {
        const ctx = createExecutionContext();
        const res = await app.fetch(new Request(`${BASE}${path}`, init), e, ctx);
        await waitOnExecutionContext(ctx);
        return res;
      };
      const up = await send(
        "/api/auth/sign-up/email",
        json({ email, password: PASSWORD, name: "m" }, { headers }),
      );
      expect(up.status).toBe(200);
      const { user } = await up.json<{ user: { id: string } }>();
      await e.DB.prepare("UPDATE user SET emailVerified = 1 WHERE id = ?").bind(user.id).run();
      const signIn = await send(
        "/api/auth/sign-in/email",
        json({ email, password: PASSWORD }, { headers }),
      );
      const token = signIn.headers.get("set-auth-token");
      expect(token).toBeTruthy();
      const sync = await send(
        "/v1/sync",
        authed(
          token ?? "",
          json({ device: { token: "metrics-device", platform: "ios" }, readAll: true }),
        ),
      );
      expect(sync.status).toBe(200);
      const body = await sync.json<{ user: { id: string }; inbox: { unreadCount: number } }>();
      expect(body.user.id).toBe(user.id);
      expect(body.inbox.unreadCount).toBe(0);
    });
    const q = logged[0]?.queries ?? {};
    expect(q["push.device.upsert"]?.rowsWritten).toBeGreaterThan(0);
    expect(q["inbox.markAllRead"]?.calls).toBe(1);
    expect(Object.keys(q).some((n) => n.startsWith("other:insert.session"))).toBe(true);
  });

  it("counts work the invocation leaves to waitUntil, then logs once", async () => {
    const id = await userWithRole();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const ctx = createExecutionContext();
    await metered(
      env,
      true,
      { via: "test" },
      async (e, c) => {
        await e.DB.prepare(USER_ROLE).bind(id).first();
        c?.waitUntil(e.DB.prepare(USER_ROLE).bind(id).first());
      },
      ctx,
    );
    // Not logged yet: the deferred statement may still be running.
    await waitOnExecutionContext(ctx);
    const logged = info.mock.calls.map((m) => m[0] as Logged).filter((l) => l.event === "d1");
    expect(logged).toHaveLength(1);
    expect(logged[0]?.queries["auth.user.role"]?.calls).toBe(2);
  });

  it("leaves unsampled invocations untouched and logs nothing", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const seen = await metered(env, false, { via: "test" }, async (e) => e);
    expect(seen).toBe(env);
    expect(info).not.toHaveBeenCalled();
  });
});
