const ACTIVITY_TOUCH_MS = 15 * 60_000;
const MAX_UA_LEN = 512;

export type ClientNetwork = {
  ipAddress: string | null;
  userAgent: string | null;
  asn: number | null;
  asOrganization: string | null;
  country: string | null;
  city: string | null;
};

export const EMPTY_NETWORK: ClientNetwork = {
  ipAddress: null,
  userAgent: null,
  asn: null,
  asOrganization: null,
  country: null,
  city: null,
};

const cleanText = (value: unknown, maxLen = 128): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLen) : null;
};

/** Edge-verified client IP (`cf-connecting-ip`) and Cloudflare `request.cf` network attributes. */
export function extractClientNetwork(req: Request | null | undefined): ClientNetwork {
  if (!req) return EMPTY_NETWORK;
  const cf = (req as Request<unknown, IncomingRequestCfProperties>).cf;
  const rawAsn = cf?.asn;
  return {
    ipAddress: cleanText(req.headers.get("cf-connecting-ip"), 64),
    userAgent: cleanText(req.headers.get("user-agent"), MAX_UA_LEN),
    asn: typeof rawAsn === "number" && Number.isInteger(rawAsn) && rawAsn > 0 ? rawAsn : null,
    asOrganization: cleanText(cf?.asOrganization, 128),
    country: cleanText(cf?.country, 8),
    city: cleanText(cf?.city, 128),
  };
}

export type TrackedSession = {
  id: string;
  asn?: number | null | undefined;
  country?: string | null | undefined;
  lastActiveAt?: string | null | undefined;
};

/**
 * Updates `lastActiveAt` and the current network of an active session in the background at most
 * once every 15 minutes, or immediately when the session moves to another ASN or country.
 */
export function touchSessionActivity(
  db: D1Database,
  ctx: Pick<ExecutionContext, "waitUntil">,
  session: TrackedSession,
  net: ClientNetwork,
  now: number,
): void {
  const lastMs = session.lastActiveAt ? Date.parse(session.lastActiveAt) : Number.NaN;
  const stale = Number.isNaN(lastMs) || now - lastMs >= ACTIVITY_TOUCH_MS;
  const networkShifted =
    (net.asn !== null && net.asn !== (session.asn ?? null)) ||
    (net.country !== null && net.country !== (session.country ?? null));
  if (!stale && !networkShifted) return;

  ctx.waitUntil(
    db
      .prepare(
        `UPDATE session
         SET lastActiveAt = ?,
             ipAddress = COALESCE(?, ipAddress),
             asn = COALESCE(?, asn),
             asOrganization = COALESCE(?, asOrganization),
             country = COALESCE(?, country),
             city = COALESCE(?, city)
         WHERE id = ?`,
      )
      .bind(
        new Date(now).toISOString(),
        net.ipAddress,
        net.asn,
        net.asOrganization,
        net.country,
        net.city,
        session.id,
      )
      .run()
      .catch((error) => console.error("session activity touch failed", error)),
  );
}
