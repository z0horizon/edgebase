export type AccentPresetId =
  | "ocean"
  | "cobalt"
  | "vermilion"
  | "emerald"
  | "teal"
  | "indigo"
  | "amber"
  | "obsidian";

export type AccentPreset = {
  id: AccentPresetId;
  label: string;
  light: string;
  dark: string;
  lightInk: string;
  darkInk: string;
};

export const ACCENT_PRESETS: readonly AccentPreset[] = [
  {
    id: "ocean",
    label: "Ocean Blue",
    light: "#0369A1",
    dark: "#0EA5E9",
    lightInk: "#075985",
    darkInk: "#38BDF8",
  },
  {
    id: "cobalt",
    label: "Cobalt",
    light: "#2554D9",
    dark: "#3B6CF0",
    lightInk: "#1E46B8",
    darkInk: "#84A9FF",
  },
  {
    id: "vermilion",
    label: "Signal Vermilion",
    light: "#C23E16",
    dark: "#E55B30",
    lightInk: "#A8330F",
    darkInk: "#F37B53",
  },
  {
    id: "emerald",
    label: "Emerald",
    light: "#0F7B55",
    dark: "#10B981",
    lightInk: "#0C6545",
    darkInk: "#34D399",
  },
  {
    id: "teal",
    label: "Oceanic Teal",
    light: "#0F6E6E",
    dark: "#14B8A6",
    lightInk: "#0B5858",
    darkInk: "#2DD4BF",
  },
  {
    id: "indigo",
    label: "Indigo",
    light: "#4338CA",
    dark: "#5552EA",
    lightInk: "#3730A3",
    darkInk: "#A5B4FC",
  },
  {
    id: "amber",
    label: "Signal Amber",
    light: "#B45309",
    dark: "#D97706",
    lightInk: "#92400E",
    darkInk: "#FBBF24",
  },
  {
    id: "obsidian",
    label: "Monochrome",
    light: "#191A1C",
    dark: "#ECEBE6",
    lightInk: "#191A1C",
    darkInk: "#F0EFEA",
  },
] as const;

export const DEFAULT_ACCENT: AccentPreference = "ocean";
export type AccentPreference = AccentPresetId | `custom:${string}`;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function normalizeHex(raw: string): string | null {
  const trimmed = raw.trim();
  const withHash = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  if (!HEX_COLOR.test(withHash)) return null;
  return withHash.toUpperCase();
}

export function parseAccentPreference(raw: string | null): AccentPreference {
  if (!raw) return DEFAULT_ACCENT;
  if (ACCENT_PRESETS.some((p) => p.id === raw)) return raw as AccentPresetId;
  if (raw.startsWith("custom:")) {
    const hex = normalizeHex(raw.slice("custom:".length));
    if (hex) return `custom:${hex}`;
  }
  return DEFAULT_ACCENT;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${[clamp(r), clamp(g), clamp(b)]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}

function mixHex(a: string, b: string, weightB: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const w = Math.max(0, Math.min(1, weightB));
  return rgbToHex(ar + (br - ar) * w, ag + (bg - ag) * w, ab + (bb - ab) * w);
}

function srgbChannel(c: number): number {
  const n = c / 255;
  return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * srgbChannel(r) + 0.7152 * srgbChannel(g) + 0.0722 * srgbChannel(b);
}

export function contrastRatio(hexA: string, hexB: string): number {
  const l1 = relativeLuminance(hexA);
  const l2 = relativeLuminance(hexB);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** Picks #FFFFFF or #141518 so button/badge labels stay above WCAG AA contrast on any accent fill. */
export function accessibleOnColor(bgHex: string): "#FFFFFF" | "#141518" {
  return contrastRatio(bgHex, "#FFFFFF") >= contrastRatio(bgHex, "#141518") ? "#FFFFFF" : "#141518";
}

/** Shifts custom colors iteratively toward target ink until >= 4.5:1 contrast against surface. */
function ensureSurfaceInkContrast(hex: string, surfaceHex: string, targetInk: string): string {
  if (contrastRatio(hex, surfaceHex) >= 4.6) return hex;
  for (let step = 1; step <= 16; step++) {
    const candidate = mixHex(hex, targetInk, step / 16);
    if (contrastRatio(candidate, surfaceHex) >= 4.6) return candidate;
  }
  return targetInk;
}

export type AccentTokens = {
  primary: string;
  primaryForeground: string;
  primaryInk: string;
  accent: string;
  accentForeground: string;
  ring: string;
  sidebarPrimary: string;
  swatchHex: string;
};

export function resolveAccentTokens(preference: AccentPreference, isDark: boolean): AccentTokens {
  const surface = isDark ? "#181A1D" : "#FFFFFF";
  const preset = ACCENT_PRESETS.find((p) => p.id === preference);

  if (preset) {
    const primary = isDark ? preset.dark : preset.light;
    const primaryInk = isDark ? preset.darkInk : preset.lightInk;
    const accent = mixHex(surface, primary, isDark ? 0.18 : 0.1);
    const accentForeground = ensureSurfaceInkContrast(
      primaryInk,
      accent,
      isDark ? "#F0EFEA" : "#141518",
    );
    return {
      primary,
      primaryForeground: accessibleOnColor(primary),
      primaryInk,
      accent,
      accentForeground,
      ring: isDark ? preset.darkInk : primary,
      sidebarPrimary: primaryInk,
      swatchHex: primary,
    };
  }

  const rawHex = preference.startsWith("custom:")
    ? (normalizeHex(preference.slice("custom:".length)) ?? "#0369A1")
    : "#0369A1";

  // Keep user's exact hue for solid buttons when legible, gently adapting ink for text readability.
  const primary = rawHex;
  const primaryInk = ensureSurfaceInkContrast(rawHex, surface, isDark ? "#F0EFEA" : "#141518");
  const accent = mixHex(surface, rawHex, isDark ? 0.18 : 0.11);
  const accentForeground = ensureSurfaceInkContrast(
    primaryInk,
    accent,
    isDark ? "#F0EFEA" : "#141518",
  );

  return {
    primary,
    primaryForeground: accessibleOnColor(primary),
    primaryInk,
    accent,
    accentForeground,
    ring: isDark ? primaryInk : primary,
    sidebarPrimary: primaryInk,
    swatchHex: rawHex,
  };
}
