import { api } from "@/lib/api";

export const PROVIDERS = [
  { id: "google", label: "Google" },
  { id: "github", label: "GitHub" },
  { id: "apple", label: "Apple" },
] as const;
export type Provider = (typeof PROVIDERS)[number]["id"];

const KNOWN_ERRORS = new Set([
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

/** Leaves for the provider; it comes back to this page, with ?error=<code> on failure. */
export async function startOAuth(
  path: "/api/auth/sign-in/social" | "/api/auth/link-social",
  provider: Provider,
) {
  // Relative paths resolve against the API's BASE_URL, which serves this page.
  const back = location.pathname;
  const { url } = await api<{ url: string }>(path, {
    method: "POST",
    body: { provider, callbackURL: back, errorCallbackURL: back },
  });
  location.assign(url);
}

// Read once at load and removed from the URL, so it is shown once even when React renders twice.
// The URL is anyone's to craft, so only known codes are shown verbatim.
let pendingError = (() => {
  const code = new URLSearchParams(location.search).get("error");
  if (!code) return "";
  history.replaceState(null, "", location.pathname + location.hash);
  return KNOWN_ERRORS.has(code)
    ? `Sign-in failed (${code.replaceAll("_", " ")}).`
    : "Sign-in failed.";
})();

/** The ?error a failed OAuth round trip left, as a message; empty after the first call. */
export function takeOAuthError(): string {
  const error = pendingError;
  pendingError = "";
  return error;
}
