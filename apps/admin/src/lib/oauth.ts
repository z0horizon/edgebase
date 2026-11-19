import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export const PROVIDERS = [
  { id: "google", label: "Google" },
  { id: "github", label: "GitHub" },
  { id: "apple", label: "Apple" },
] as const;
export type Provider = (typeof PROVIDERS)[number]["id"];

type SignInOptions = { appName: string; providers: string[]; emailPassword: boolean };

const STORAGE_KEY = "edgebase:sign-in-options";

/** The last answer this browser saw, so the page renders in its final shape before the request returns. */
function readStored(): SignInOptions | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (
      typeof v === "object" &&
      v !== null &&
      "appName" in v &&
      typeof v.appName === "string" &&
      "providers" in v &&
      Array.isArray(v.providers) &&
      v.providers.every((p) => typeof p === "string") &&
      "emailPassword" in v &&
      typeof v.emailPassword === "boolean"
    ) {
      return { appName: v.appName, providers: v.providers, emailPassword: v.emailPassword };
    }
  } catch {
    // Storage blocked or a bad value: start without it.
  }
  return null;
}

let last: SignInOptions | null = readStored();

// One request per page load, shared by every component that asks; a failure is not cached.
let pending: Promise<SignInOptions> | null = null;
function loadSignInOptions(): Promise<SignInOptions> {
  pending ??= api<Partial<SignInOptions>>("/v1/auth/providers").then(
    (r) => {
      last = {
        appName: r.appName || "EdgeBase",
        providers: r.providers ?? [],
        emailPassword: r.emailPassword !== false,
      };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(last));
      } catch {
        // Not remembered; the next load waits for the server again.
      }
      return last;
    },
    (error: unknown) => {
      pending = null;
      throw error;
    },
  );
  return pending;
}

/**
 * What the server says about itself: the product name (APP_NAME), the providers it has credentials
 * for and whether email and password is on. Until it answers, the last answer this browser saw, or
 * else no name, no providers and null; when the request fails, the password form stays reachable.
 */
export function useSignInOptions() {
  const [options, setOptions] = useState<{
    appName: string;
    providers: string[];
    emailPassword: boolean | null;
  }>(() => last ?? { appName: "", providers: [], emailPassword: null });
  useEffect(() => {
    let live = true;
    loadSignInOptions()
      .then((r) => live && setOptions(r))
      .catch(
        () =>
          live &&
          setOptions((prev) => ({
            appName: prev.appName || "EdgeBase",
            providers: prev.providers,
            emailPassword: prev.emailPassword ?? true,
          })),
      );
    return () => {
      live = false;
    };
  }, []);
  const on = new Set(options.providers);
  return {
    appName: options.appName,
    providers: PROVIDERS.filter((p) => on.has(p.id)),
    emailPassword: options.emailPassword,
  };
}

/** The product name from APP_NAME (empty only on a first visit, until the server answers). Also names the browser tab. */
export function useAppName() {
  const { appName } = useSignInOptions();
  useEffect(() => {
    if (appName) document.title = `${appName} Console`;
  }, [appName]);
  return appName;
}

/** The providers the server has credentials for; empty until it answers or when it fails. */
export function useProviders() {
  return useSignInOptions().providers;
}

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
  const back = `${location.pathname}${location.hash}`;
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
