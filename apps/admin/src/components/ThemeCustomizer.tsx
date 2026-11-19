import { cn } from "cn";
import { Check, Monitor, Moon, Palette, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ACCENT_PRESETS, accessibleOnColor, normalizeHex } from "@/lib/accent";
import { type ThemePreference, useTheme } from "@/lib/theme";

const THEME_LABELS: Record<ThemePreference, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

/** Reusable swatch grid + custom hex picker for live primary accent customization. */
export function AccentSwatchPicker({ compact = false }: { compact?: boolean }) {
  const { resolved, accent, accentSwatch, setAccent } = useTheme();
  const [hexDraft, setHexDraft] = useState(accentSwatch);
  const isCustom = accent.startsWith("custom:");

  useEffect(() => {
    setHexDraft(accentSwatch);
  }, [accentSwatch]);

  const applyCustom = (raw: string) => {
    setHexDraft(raw);
    const valid = normalizeHex(raw);
    if (valid) setAccent(`custom:${valid}`);
  };

  return (
    <div className="grid gap-2">
      <div className={cn("flex flex-wrap items-center", compact ? "gap-1.5" : "gap-2")}>
        {ACCENT_PRESETS.map((preset) => {
          const active = accent === preset.id;
          const swatchColor = resolved === "dark" ? preset.dark : preset.light;
          const checkInk = accessibleOnColor(swatchColor);
          return (
            <button
              key={preset.id}
              type="button"
              title={preset.label}
              aria-label={`Use ${preset.label} accent color`}
              aria-pressed={active}
              onClick={() => {
                setAccent(preset.id);
                setHexDraft(swatchColor);
              }}
              className={cn(
                "grid place-items-center rounded-[3px] border transition-transform duration-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                compact ? "size-5" : "size-6",
                active
                  ? "scale-105 border-foreground ring-2 ring-ring/35"
                  : "border-black/15 hover:scale-105 dark:border-white/25",
              )}
              style={{ backgroundColor: swatchColor }}
            >
              {active && (
                <Check
                  className={cn("stroke-[2.5]", compact ? "size-3" : "size-3.5")}
                  style={{ color: checkInk }}
                />
              )}
            </button>
          );
        })}

        <label
          title="Pick custom primary color"
          className={cn(
            "relative grid cursor-pointer place-items-center overflow-hidden rounded-[3px] border transition-colors has-focus-visible:ring-2 has-focus-visible:ring-ring",
            compact ? "h-5 px-1.5" : "h-6 px-2",
            isCustom
              ? "border-foreground bg-secondary font-medium text-foreground ring-2 ring-ring/30"
              : "border-input bg-card text-muted-foreground hover:text-foreground",
          )}
        >
          <span className="flex items-center gap-1 font-mono text-[10px]">
            <span
              aria-hidden="true"
              className="size-2.5 rounded-[2px] border border-black/15 dark:border-white/20"
              style={{ backgroundColor: accentSwatch }}
            />
            Custom
          </span>
          <input
            type="color"
            aria-label="Custom primary color"
            value={accentSwatch}
            onChange={(e) => applyCustom(e.target.value)}
            className="absolute inset-0 cursor-pointer opacity-0"
          />
        </label>
      </div>

      {!compact && (
        <div className="flex items-center gap-2">
          <input
            type="text"
            aria-label="Hex color code"
            value={hexDraft}
            maxLength={7}
            spellCheck={false}
            onChange={(e) => applyCustom(e.target.value)}
            placeholder="#0369A1"
            className="h-7 w-24 rounded-md border border-input bg-card px-2 font-mono text-xs text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25"
          />
          <span className="text-[11px] text-muted-foreground">
            {ACCENT_PRESETS.find((p) => p.id === accent)?.label ?? `Custom (${accentSwatch})`}
          </span>
        </div>
      )}
    </div>
  );
}

/** Compact theme & accent trigger used on Auth Portal and onboarding headers. */
export function AuthAppearanceControl() {
  const { preference, accentSwatch, setPreference } = useTheme();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Appearance and primary color"
          className="inline-flex h-8 items-center gap-2 rounded-md border border-input bg-card px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-secondary/80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <span
            aria-hidden="true"
            className="size-3 rounded-[2px] border border-black/15 dark:border-white/20"
            style={{ backgroundColor: accentSwatch }}
          />
          <Palette className="size-3.5 text-muted-foreground" />
          <span>{THEME_LABELS[preference]}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60 p-2">
        <DropdownMenuLabel className="px-1.5 py-1 text-[11px] font-medium text-muted-foreground">
          Appearance
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={preference}
          onValueChange={(v) => setPreference(v as ThemePreference)}
        >
          <DropdownMenuRadioItem value="system">
            <Monitor /> System
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="light">
            <Sun /> Light
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">
            <Moon /> Dark
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator className="my-1.5" />
        <div className="grid gap-1.5 px-1.5 py-1">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium text-muted-foreground">Primary color</span>
            <span className="font-mono text-[10px] text-muted-foreground">{accentSwatch}</span>
          </div>
          <AccentSwatchPicker compact />
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
