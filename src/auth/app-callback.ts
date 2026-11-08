import type { Context } from "hono";
import type { AppEnv } from "../app";
import { createAuth } from "./auth";

/**
 * End of a browser OAuth flow started by a native app: hands the app a one-time token through
 * its URL scheme, so the session token itself never appears in a URL.
 */
export async function appCallback(c: Context<AppEnv>): Promise<Response> {
  const { token } = await createAuth(c.env, c.executionCtx).api.generateOneTimeToken({
    headers: c.req.raw.headers,
  });
  return c.redirect(`${c.env.APP_SCHEME}://auth?token=${encodeURIComponent(token)}`, 302);
}
