/** Whether active sessions get their lastActiveAt and current network refreshed (SESSION_ACTIVITY). */
export const sessionActivityEnabled = (env: Env) =>
  env.SESSION_ACTIVITY?.trim().toLowerCase() !== "off";

/** The product name people see: mail subjects, authenticator and passkey labels, the admin page. */
export const appName = (env: Env) =>
  // Deploys validate it, but a dashboard or .dev.vars edit does not: no line breaks into a mail
  // subject, and the same 40-character cap.
  env.APP_NAME?.replace(/[\p{Cc}\u2028\u2029]/gu, "")
    .trim()
    .slice(0, 40) || "EdgeBase";
