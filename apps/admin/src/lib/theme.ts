import { useSyncExternalStore } from "react";
import {
  type AccentPreference,
  DEFAULT_ACCENT,
  parseAccentPreference,
  resolveAccentTokens,
} from "./accent";

export type ThemePreference = "system" | "light" | "dark";

const THEME_STORAGE_KEY = "edgebase:theme";
const ACCENT_STORAGE_KEY = "edgebase:accent";
const listeners = new Set<() => void>();

function readStoredTheme(): ThemePreference {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    // Storage may be blocked in strict privacy contexts; default to system.
  }
  return "system";
}

function readStoredAccent(): AccentPreference {
  try {
    return parseAccentPreference(localStorage.getItem(ACCENT_STORAGE_KEY));
  } catch {
    return DEFAULT_ACCENT;
  }
}

let currentPreference: ThemePreference = "system";
let currentAccent: AccentPreference = DEFAULT_ACCENT;
let initialized = false;

function resolveDark(pref: ThemePreference): boolean {
  if (pref === "dark") return true;
  if (pref === "light") return false;
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyDocumentAppearance(pref: ThemePreference, accentPref: AccentPreference) {
  if (typeof document === "undefined") return;
  const isDark = resolveDark(pref);
  const root = document.documentElement;
  root.classList.toggle("dark", isDark);
  root.style.colorScheme = isDark ? "dark" : "light";

  const tokens = resolveAccentTokens(accentPref, isDark);
  root.style.setProperty("--primary", tokens.primary);
  root.style.setProperty("--primary-foreground", tokens.primaryForeground);
  root.style.setProperty("--primary-ink", tokens.primaryInk);
  root.style.setProperty("--accent", tokens.accent);
  root.style.setProperty("--accent-foreground", tokens.accentForeground);
  root.style.setProperty("--ring", tokens.ring);
  root.style.setProperty("--sidebar-primary", tokens.sidebarPrimary);
  root.style.setProperty("--sidebar-ring", tokens.ring);
}

export function initTheme() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  currentPreference = readStoredTheme();
  currentAccent = readStoredAccent();
  applyDocumentAppearance(currentPreference, currentAccent);
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", () => {
    if (currentPreference === "system") {
      applyDocumentAppearance("system", currentAccent);
      for (const listener of listeners) listener();
    }
  });
}

export function setThemePreference(next: ThemePreference) {
  currentPreference = next;
  try {
    if (next === "system") localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // Ignore storage write errors and still apply in-memory.
  }
  applyDocumentAppearance(currentPreference, currentAccent);
  for (const listener of listeners) listener();
}

export function setAccentPreference(next: AccentPreference) {
  currentAccent = next;
  try {
    if (next === DEFAULT_ACCENT) localStorage.removeItem(ACCENT_STORAGE_KEY);
    else localStorage.setItem(ACCENT_STORAGE_KEY, next);
  } catch {
    // Ignore storage write errors and still apply in-memory.
  }
  applyDocumentAppearance(currentPreference, currentAccent);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme(): {
  preference: ThemePreference;
  resolved: "light" | "dark";
  accent: AccentPreference;
  accentSwatch: string;
  setPreference: (next: ThemePreference) => void;
  setAccent: (next: AccentPreference) => void;
} {
  initTheme();
  const preference = useSyncExternalStore(
    subscribe,
    () => currentPreference,
    () => "system" as ThemePreference,
  );
  const accent = useSyncExternalStore(
    subscribe,
    () => currentAccent,
    () => DEFAULT_ACCENT,
  );
  const isDark = resolveDark(preference);
  return {
    preference,
    resolved: isDark ? "dark" : "light",
    accent,
    accentSwatch: resolveAccentTokens(accent, isDark).swatchHex,
    setPreference: setThemePreference,
    setAccent: setAccentPreference,
  };
}
