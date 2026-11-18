import { useSyncExternalStore } from "react";

export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "edgebase:theme";
const listeners = new Set<() => void>();

function readStoredPreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    // Storage may be blocked in strict privacy contexts; default to system.
  }
  return "system";
}

let currentPreference: ThemePreference = "system";
let initialized = false;

function resolveDark(pref: ThemePreference): boolean {
  if (pref === "dark") return true;
  if (pref === "light") return false;
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyDocumentTheme(pref: ThemePreference) {
  if (typeof document === "undefined") return;
  const isDark = resolveDark(pref);
  document.documentElement.classList.toggle("dark", isDark);
  document.documentElement.style.colorScheme = isDark ? "dark" : "light";
}

export function initTheme() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  currentPreference = readStoredPreference();
  applyDocumentTheme(currentPreference);
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", () => {
    if (currentPreference === "system") {
      applyDocumentTheme("system");
      for (const listener of listeners) listener();
    }
  });
}

export function setThemePreference(next: ThemePreference) {
  currentPreference = next;
  try {
    if (next === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Ignore storage write errors and still apply in-memory.
  }
  applyDocumentTheme(next);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme(): {
  preference: ThemePreference;
  resolved: "light" | "dark";
  setPreference: (next: ThemePreference) => void;
} {
  initTheme();
  const preference = useSyncExternalStore(
    subscribe,
    () => currentPreference,
    () => "system" as ThemePreference,
  );
  return {
    preference,
    resolved: resolveDark(preference) ? "dark" : "light",
    setPreference: setThemePreference,
  };
}
