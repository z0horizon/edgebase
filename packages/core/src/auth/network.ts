import { SESSION_TOUCH_ACTIVITY } from "./queries";

// A daily write is enough to show when a session was last used; it is a D1 row write each time.
const ACTIVITY_TOUCH_MS = 24 * 60 * 60_000;
// Phones hop between Wi-Fi and mobile carriers all day; one write per hop would dominate session writes.
const ASN_TOUCH_MS = 6 * 60 * 60_000;
const MAX_UA_LEN = 512;
const HEX_GROUP = /^[0-9a-f]{1,4}$/;

/**
 * Normalizes a client IP for per-network rate limiting: IPv4 and IPv4-mapped IPv6 keep their
 * `/32` address, while native IPv6 addresses collapse to their canonical `/64` prefix.
 */
export function normalizeRateLimitIp(raw: string | null | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed.length > 128) return "unknown";
  const unbracketed =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  const ip = (unbracketed.split("%")[0] ?? "").toLowerCase();
  if (!ip) return "unknown";
  if (!ip.includes(":")) return ip;

  let normalized = ip;
  const lastColon = ip.lastIndexOf(":");
  const tail = ip.slice(lastColon + 1);
  if (tail.includes(".")) {
    const octets = tail.split(".");
    if (octets.length !== 4) return ip;
    const bytes: number[] = [];
    for (const part of octets) {
      if (!/^\d{1,3}$/.test(part)) return ip;
      const n = Number(part);
      if (n > 255) return ip;
      bytes.push(n);
    }
    const hi = (((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0)).toString(16);
    const lo = (((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0)).toString(16);
    normalized = `${ip.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return ip;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  if ((halves.length === 1 && left.length !== 8) || (halves.length === 2 && missing < 1)) {
    return ip;
  }
  const groups = [...left, ...Array<string>(missing).fill("0"), ...right];
  if (groups.length !== 8 || !groups.every((g) => HEX_GROUP.test(g))) return ip;
  const nums = groups.map((g) => Number.parseInt(g, 16));

  if (
    nums[0] === 0 &&
    nums[1] === 0 &&
    nums[2] === 0 &&
    nums[3] === 0 &&
    nums[4] === 0 &&
    nums[5] === 0xffff
  ) {
    const hi = nums[6] ?? 0;
    const lo = nums[7] ?? 0;
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }

  return `${nums
    .slice(0, 4)
    .map((n) => n.toString(16).padStart(4, "0"))
    .join(":")}::/64`;
}

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
 * Updates `lastActiveAt` and the current network of an active session in the background: at once
 * when the session moves to another country, at most every 6 hours when only its ASN changed,
 * and otherwise at most daily.
 */
export function touchSessionActivity(
  db: D1Database,
  ctx: Pick<ExecutionContext, "waitUntil">,
  session: TrackedSession,
  net: ClientNetwork,
  now: number,
): void {
  const lastMs = session.lastActiveAt ? Date.parse(session.lastActiveAt) : Number.NaN;
  const idleMs = Number.isNaN(lastMs) ? Number.POSITIVE_INFINITY : now - lastMs;
  const countryShifted = net.country !== null && net.country !== (session.country ?? null);
  const asnShifted = net.asn !== null && net.asn !== (session.asn ?? null);
  if (!countryShifted && idleMs < (asnShifted ? ASN_TOUCH_MS : ACTIVITY_TOUCH_MS)) return;

  ctx.waitUntil(
    db
      .prepare(SESSION_TOUCH_ACTIVITY)
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
      .catch((error) =>
        console.error({ event: "session_activity_touch_failed", error: String(error) }),
      ),
  );
}
