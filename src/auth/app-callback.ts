import type { Context } from "hono";
import * as v from "valibot";
import type { AppEnv } from "../app";
import { base64url, jsonError, parseBody } from "../http";
import { createAuth } from "./auth";

const HANDOFF_TTL_MS = 3 * 60_000;
// RFC 7636: a 43-128 char verifier; its challenge is the base64url SHA-256 (43 chars).
const ChallengeSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/));
const ExchangeSchema = v.object({
  token: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
  verifier: v.pipe(v.string(), v.regex(/^[A-Za-z0-9._~-]{43,128}$/)),
});

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

const handoffId = async (token: string) => `app-handoff:${base64url(await sha256(token))}`;

/**
 * End of a browser OAuth flow started by a native app. The app opens it with the challenge of a
 * secret verifier it keeps; the one-time token sent back through the URL scheme is useless to
 * another app that claims the scheme, because only the verifier can redeem it.
 */
export async function appCallback(c: Context<AppEnv>): Promise<Response> {
  // The app is waiting on its URL scheme, so failures go back there too, not to a JSON page.
  const fail = (error: string) => c.redirect(`${c.env.APP_SCHEME}://auth?error=${error}`, 302);
  const challenge = v.safeParse(ChallengeSchema, c.req.query("challenge"));
  if (!challenge.success) return fail("invalid_challenge");
  const auth = createAuth(c.env, c.executionCtx);
  if (!(await auth.api.getSession({ headers: c.req.raw.headers }))) return fail("unauthorized");
  const { token } = await auth.api.generateOneTimeToken({ headers: c.req.raw.headers });
  const now = Date.now();
  // Stored in Better Auth's verification table so the daily expiry cleanup covers it.
  await c.env.DB.prepare(
    `INSERT INTO verification (id, identifier, value, expiresAt, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      await handoffId(token),
      challenge.output,
      new Date(now + HANDOFF_TTL_MS).toISOString(),
      new Date(now).toISOString(),
      new Date(now).toISOString(),
    )
    .run();
  return c.redirect(`${c.env.APP_SCHEME}://auth?token=${encodeURIComponent(token)}`, 302);
}

/** Redeems a hand-off token with its verifier; answers the bearer session token. */
export async function appExchange(c: Context<AppEnv>): Promise<Response> {
  const body = await parseBody(c, ExchangeSchema);
  if (body instanceof Response) return body;
  const rejected = () => jsonError(401, "unauthorized", "Hand-off token is invalid or expired");

  // Deleted on first use, right or wrong, so an intercepted token cannot be retried.
  const row = await c.env.DB.prepare(
    "DELETE FROM verification WHERE identifier = ? RETURNING value, expiresAt",
  )
    .bind(await handoffId(body.token))
    .first<{ value: string; expiresAt: string }>();
  if (!row || row.expiresAt < new Date().toISOString()) return rejected();
  if (base64url(await sha256(body.verifier)) !== row.value) return rejected();

  try {
    const { session, user } = await createAuth(c.env, c.executionCtx).api.verifyOneTimeToken({
      body: { token: body.token },
    });
    return c.json({ token: session.token, user });
  } catch {
    return rejected();
  }
}
