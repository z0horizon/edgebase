import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { app } from "../src/app";

export const BASE = "https://api.test";
export const PASSWORD = "pw-correct-horse-1";

/** A request to the Worker that also waits for the work it left running. */
export async function call(path: string, init: RequestInit = {}, bindings: Env = env) {
  const ctx = createExecutionContext();
  const res = await app.request(`${BASE}${path}`, init, bindings, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

let ipCounter = 0;
/** A fresh client IP, so one test's auth calls never share AUTH_RL's budget with another's. */
export const freshIp = () => `198.51.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

export function json(body: unknown, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  headers.set("origin", "https://web.test");
  return { method: "POST", ...init, headers, body: JSON.stringify(body) };
}

export function authed(token: string, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return { ...init, headers };
}

/** A signed-in user whose email is already verified, with its bearer token. */
export async function signUpVerified(email: string): Promise<{ userId: string; token: string }> {
  const headers = { "cf-connecting-ip": freshIp() };
  const signUp = await call(
    "/api/auth/sign-up/email",
    json({ email, password: PASSWORD, name: email }, { headers }),
  );
  const { user } = await signUp.json<{ user: { id: string } }>();
  await env.DB.prepare("UPDATE user SET emailVerified = 1 WHERE id = ?").bind(user.id).run();
  const signIn = await call(
    "/api/auth/sign-in/email",
    json({ email, password: PASSWORD }, { headers }),
  );
  const token = signIn.headers.get("set-auth-token");
  if (!token) throw new Error(`sign-in failed: ${signIn.status} ${await signIn.text()}`);
  return { userId: user.id, token };
}

let userCounter = 0;
/** Inserts a verified user straight into D1 and returns its id. */
export async function seedUser(createdAt = Date.UTC(2026, 10, 1), extra = ""): Promise<string> {
  const id = `seed-${++userCounter}${extra}`;
  const iso = new Date(createdAt).toISOString();
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)",
  )
    .bind(id, id, `${id}@seed.test`, iso, iso)
    .run();
  return id;
}
