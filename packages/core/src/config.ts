/** Whether active sessions get their lastActiveAt and current network refreshed (SESSION_ACTIVITY). */
export const sessionActivityEnabled = (env: Env) =>
  env.SESSION_ACTIVITY?.trim().toLowerCase() !== "off";

/** Whether the Worker sends mail at all (EMAIL_SENDING); off, deploys carry no mail binding. */
export const emailSendingEnabled = (env: Env) => env.EMAIL_SENDING?.trim().toLowerCase() !== "off";

/**
 * Days between writes that push an active session's 30-day expiry forward (SESSION_REFRESH_DAYS,
 * 1 to 14, default 1). A session unused for 30 days minus this many days may already have expired.
 */
export function sessionRefreshDays(env: Env): number {
  const days = Number(env.SESSION_REFRESH_DAYS?.trim() || "1");
  return Number.isInteger(days) && days >= 1 && days <= 14 ? days : 1;
}

/** The product name people see: mail subjects, authenticator and passkey labels, the admin page. */
export const appName = (env: Env) =>
  // Deploys validate it, but a dashboard or .dev.vars edit does not: no line breaks into a mail
  // subject, and the same 40-character cap.
  env.APP_NAME?.replace(/[\p{Cc}\u2028\u2029]/gu, "")
    .trim()
    .slice(0, 40) || "EdgeBase";
