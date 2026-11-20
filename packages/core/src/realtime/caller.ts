// What an API call over a personal socket acts as. A leaf module: routes.ts reads these at the
// upgrade, and api.ts (which imports the app) uses them in the hub, without routes importing it.

/** The upgrade's forwarded headers and Cloudflare network, replayed on each call (see batch). */
export type ApiCaller = { headers: Record<string, string>; cf: unknown };

/** Largest serialized ApiCaller kept in a socket's attachment (16 KB in all). */
export const MAX_CALLER_CHARS = 12 * 1024;

/** Better Auth's cookies (`better-auth.*`, `__Secure-better-auth.*`); other cookies are not kept. */
const AUTH_COOKIE = /^(__Secure-)?better-auth\./;

/** Only the auth cookies of a Cookie header, or undefined when there are none. */
export function authCookies(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const kept = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => AUTH_COOKIE.test(part));
  return kept.length > 0 ? kept.join("; ") : undefined;
}
