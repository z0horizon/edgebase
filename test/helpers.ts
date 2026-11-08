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
  const signUp = await call(
    "/api/auth/sign-up/email",
    json({ email, password: PASSWORD, name: email }),
  );
  const { user } = await signUp.json<{ user: { id: string } }>();
  await env.DB.prepare("UPDATE user SET emailVerified = 1 WHERE id = ?").bind(user.id).run();
  const signIn = await call("/api/auth/sign-in/email", json({ email, password: PASSWORD }));
  const token = signIn.headers.get("set-auth-token");
  if (!token) throw new Error(`sign-in failed: ${signIn.status} ${await signIn.text()}`);
  return { userId: user.id, token };
}
