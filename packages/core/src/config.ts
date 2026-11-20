/** Whether active sessions get their lastActiveAt and current network refreshed (SESSION_ACTIVITY). */
export const sessionActivityEnabled = (env: Env) =>
  env.SESSION_ACTIVITY?.trim().toLowerCase() !== "off";

/** Whether the Worker sends mail at all (EMAIL_SENDING); off, deploys carry no mail binding. */
export const emailSendingEnabled = (env: Env) => env.EMAIL_SENDING?.trim().toLowerCase() !== "off";

/**
 * Days between writes that push an active session's 30-day expiry forward (SESSION_REFRESH_DAYS,
 * 1 to 14, default 3). A session unused for 30 days minus this many days may already have expired.
 */
export function sessionRefreshDays(env: Env): number {
  const days = Number(env.SESSION_REFRESH_DAYS?.trim() || "3");
  return Number.isInteger(days) && days >= 1 && days <= 14 ? days : 3;
}

/** The product name people see: mail subjects, authenticator and passkey labels, the admin page. */
export const appName = (env: Env) =>
  // Deploys validate it, but a dashboard or .dev.vars edit does not: no line breaks into a mail
  // subject, and the same 40-character cap.
  env.APP_NAME?.replace(/[\p{Cc}\u2028\u2029]/gu, "")
    .trim()
    .slice(0, 40) || "EdgeBase";

/** Longest INBOX_TTL_DAYS: a read names one table per week of the TTL, so it must stay small. */
export const MAX_INBOX_TTL_DAYS = 90;

/**
 * Days inbox items are listed (INBOX_TTL_DAYS, 1 to 90, default 30). Deploys validate it; a value
 * outside that range from a dashboard or .dev.vars edit falls back to 30.
 */
export function inboxTtlDays(env: Env): number {
  const days = Number(env.INBOX_TTL_DAYS?.trim() || "30");
  return Number.isInteger(days) && days >= 1 && days <= MAX_INBOX_TTL_DAYS ? days : 30;
}
