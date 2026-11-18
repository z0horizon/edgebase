import { insertPersonal } from "../inbox/queries";
import { sendMail } from "../mail";
import type { ClientNetwork } from "./network";

const ALERT_WINDOW_MS = 3_600_000;
const MAX_SECURITY_ALERTS_PER_HOUR = 3;
const ALERT_UA_MAX_LEN = 80;

/** Strips control chars, HTML brackets, and URLs from User-Agent before placing it in alerts. */
export function sanitizeUserAgentForAlert(userAgent: string | null): string {
  if (!userAgent) return "Unknown device";
  const cleaned = Array.from(userAgent)
    .map((ch) => {
      const code = ch.charCodeAt(0);
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? " " : ch;
    })
    .join("")
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned ? cleaned.slice(0, ALERT_UA_MAX_LEN) : "Unknown device";
}

async function hasReachedAlertCap(db: D1Database, userId: string, now: number): Promise<boolean> {
  // Uses `inbox_item_user_created_at` so sign-in loops cannot bloat `INBOX_DB` or exhaust `MAIL`.
  const recent = await db
    .prepare(
      `SELECT count(*) AS n FROM inbox_item
       WHERE user_id = ? AND created_at > ? AND category = 'transactional'
         AND json_extract(data, '$.kind') = 'security_alert'`,
    )
    .bind(userId, now - ALERT_WINDOW_MS)
    .first<number>("n");
  return (recent ?? 0) >= MAX_SECURITY_ALERTS_PER_HOUR;
}

async function dispatchSecurityAlert(
  env: Env,
  user: { id: string; email: string },
  title: string,
  subject: string,
  summary: string,
  now: number,
): Promise<void> {
  if (await hasReachedAlertCap(env.INBOX_DB, user.id, now)) return;
  await Promise.all([
    insertPersonal(
      env.INBOX_DB,
      [user.id],
      {
        title,
        body: summary,
        category: "transactional",
        data: { kind: "security_alert" },
      },
      now,
    ),
    sendMail(env, { to: user.email, subject, text: summary }),
  ]);
}

const formatLocation = (net: ClientNetwork) =>
  [net.city, net.country].filter(Boolean).join(", ") || "Unknown location";

export async function notifyNewNetworkSignIn(
  env: Env,
  user: { id: string; email: string },
  sessionId: string,
  net: ClientNetwork,
  now: number,
  excludeTrustedDeviceId: string | null = null,
): Promise<void> {
  if (net.asn === null && net.country === null) return;
  const nowIso = new Date(now).toISOString();

  // Single short-circuiting EXISTS query on DB (1 round-trip, stops at first matching row).
  const check = await env.DB.prepare(
    `SELECT
       EXISTS(
         SELECT 1 FROM session WHERE userId = ?1 AND id <> ?2 AND expiresAt > ?3
         UNION ALL
         SELECT 1 FROM trusted_device
         WHERE user_id = ?1 AND expires_at > ?4 AND (?7 IS NULL OR id <> ?7)
       ) AS hasPrior,
       EXISTS(
         SELECT 1 FROM session
         WHERE userId = ?1 AND id <> ?2 AND expiresAt > ?3
           AND (
             (COALESCE(asn, -1) = COALESCE(?5, -1) AND COALESCE(country, '') = COALESCE(?6, ''))
             OR (COALESCE(createdAsn, -1) = COALESCE(?5, -1) AND COALESCE(createdCountry, '') = COALESCE(?6, ''))
           )
         UNION ALL
         SELECT 1 FROM trusted_device
         WHERE user_id = ?1 AND expires_at > ?4 AND (?7 IS NULL OR id <> ?7)
           AND (
             (COALESCE(asn, -1) = COALESCE(?5, -1) AND COALESCE(country, '') = COALESCE(?6, ''))
             OR (COALESCE(created_asn, -1) = COALESCE(?5, -1) AND COALESCE(created_country, '') = COALESCE(?6, ''))
           )
       ) AS hasMatch`,
  )
    .bind(user.id, sessionId, nowIso, now, net.asn, net.country, excludeTrustedDeviceId)
    .first<{ hasPrior: number; hasMatch: number }>();

  if (!check || check.hasPrior === 0 || check.hasMatch === 1) return;

  const isp = net.asOrganization
    ? net.asn
      ? `${net.asOrganization} (AS${net.asn})`
      : net.asOrganization
    : net.asn
      ? `AS${net.asn}`
      : "Unknown network";
  const device = sanitizeUserAgentForAlert(net.userAgent);
  const ip = net.ipAddress ?? "Unknown IP";
  const summary = `New sign-in on ${device} from ${formatLocation(net)} — ${isp} (IP: ${ip}) at ${nowIso}. If this was not you, revoke the session and change your password immediately.`;

  await dispatchSecurityAlert(
    env,
    user,
    "New sign-in from an unfamiliar network",
    "Security alert: new sign-in detected",
    summary,
    now,
  );
}

export async function notifyPasskeyAdded(
  env: Env,
  user: { id: string; email: string },
  passkeyName: string | null,
  net: ClientNetwork,
  now: number,
): Promise<void> {
  const label = sanitizeUserAgentForAlert(passkeyName || "Passkey");
  const device = sanitizeUserAgentForAlert(net.userAgent);
  const ip = net.ipAddress ?? "Unknown IP";
  const nowIso = new Date(now).toISOString();
  const summary = `A new passkey "${label}" was added to your account on ${device} from ${formatLocation(net)} (IP: ${ip}) at ${nowIso}. If you did not add this passkey, remove it immediately from Account Security.`;

  await dispatchSecurityAlert(
    env,
    user,
    "New passkey added to your account",
    "Security alert: new passkey added",
    summary,
    now,
  );
}
