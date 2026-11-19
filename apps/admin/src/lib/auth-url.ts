export type AuthMode = "signin" | "signup" | "forgot" | "reset" | "verified";

const KNOWN_OAUTH_ERRORS = new Set([
  "account_not_linked",
  "access_denied",
  "unable_to_link_account",
  "unable_to_get_user_info",
  "email_not_found",
  "email_doesn't_match",
  "account_already_linked_to_different_user",
  "state_mismatch",
  "please_restart_the_process",
]);

export type AuthUrlState = {
  initialMode: AuthMode;
  resetToken: string;
  authError: string;
  oauthError: string;
};

/**
 * Inspects query and hash parameters once when the page opens so password-reset tokens,
 * email-verification callbacks, and OAuth errors route cleanly without leaking tokens in history.
 */
export function parseAuthUrl(
  search: string,
  hash: string,
): {
  state: AuthUrlState;
  cleanedHash: string | null;
} {
  const params = new URLSearchParams(search);
  const token = params.get("token")?.trim() ?? "";
  const error = params.get("error")?.trim() ?? "";
  const cleanHash = hash.split("?")[0] ?? hash;

  const isResetHash = cleanHash === "#reset-password" || cleanHash === "#reset";
  const isVerifiedHash = cleanHash === "#verified";
  const isForgotHash = cleanHash === "#forgot-password" || cleanHash === "#forgot";
  const isSignUpHash = cleanHash === "#signup" || cleanHash === "#register";

  let initialMode: AuthMode = "signin";
  if (isResetHash || token) initialMode = "reset";
  else if (isVerifiedHash) initialMode = "verified";
  else if (isForgotHash) initialMode = "forgot";
  else if (isSignUpHash) initialMode = "signup";

  let authError = "";
  let oauthError = "";

  if (error) {
    if (isResetHash || (!isVerifiedHash && error === "INVALID_TOKEN")) {
      initialMode = "reset";
      authError = "This password reset link is invalid or has expired. Request a new link below.";
    } else if (isVerifiedHash) {
      initialMode = "verified";
      authError =
        "This email verification link is invalid or has expired. Request a new one below.";
    } else {
      oauthError = KNOWN_OAUTH_ERRORS.has(error)
        ? `Sign-in failed (${error.replaceAll("_", " ")}).`
        : "Sign-in failed.";
    }
  }

  const shouldScrub = Boolean(token || error);
  return {
    state: {
      initialMode,
      resetToken: token,
      authError,
      oauthError,
    },
    cleanedHash: shouldScrub ? cleanHash : null,
  };
}
