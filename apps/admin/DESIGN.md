---
name: "EdgeBase Control Plane"
description: "Technical Spec Sheet identity portal and D1 operations console with Ocean Blue default accent and live chroma customization."
colors:
  ocean-primary: "#0369a1"
  ocean-primary-dark: "#0ea5e9"
  ocean-ink: "#075985"
  ocean-ink-dark: "#38bdf8"
  ocean-wash: "#e6f0f6"
  ocean-wash-dark: "#163342"
  canvas-stone: "#f3f2ee"
  canvas-graphite: "#111214"
  surface-sheet: "#ffffff"
  surface-graphite: "#181a1d"
  surface-popover-dark: "#1e2025"
  rail-light: "#ffffff"
  rail-dark: "#141518"
  surface-secondary: "#eceae4"
  surface-secondary-dark: "#24272d"
  surface-muted: "#eae8e1"
  surface-muted-dark: "#202227"
  ink-carbon: "#191a1c"
  ink-chalk: "#f0efea"
  ink-muted: "#5e5d58"
  ink-muted-dark: "#9c9e9a"
  border-hairline: "#dcdad3"
  border-hairline-dark: "#2b2e35"
  border-control: "#c6c3b9"
  border-control-dark: "#3a3e48"
  emerald-status: "#0f7b55"
  emerald-status-dark: "#34d399"
  amber-status: "#b45309"
  amber-status-dark: "#fbbf24"
  crimson-danger: "#c92a2a"
  crimson-danger-dark: "#f06565"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, Inter, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.025em"
    fontFeature: "\"cv02\", \"cv03\", \"cv04\", \"cv11\""
  wordmark:
    fontFamily: "-apple-system, BlinkMacSystemFont, Inter, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.015em"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, Inter, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.35
  nav:
    fontFamily: "-apple-system, BlinkMacSystemFont, Inter, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "13.5px"
    fontWeight: 500
    lineHeight: 1.4
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, Inter, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  caption:
    fontFamily: "-apple-system, BlinkMacSystemFont, Inter, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, Inter, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.2
  micro:
    fontFamily: "SF Mono, JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
    fontSize: "10px"
    fontWeight: 500
    lineHeight: 1.2
    fontFeature: "\"tnum\""
rounded:
  xs: "2px"
  sm: "3px"
  md: "4px"
  lg: "6px"
spacing:
  2xs: "4px"
  xs: "6px"
  sm: "10px"
  md: "16px"
  lg: "20px"
  xl: "28px"
  2xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.ocean-primary}"
    textColor: "{colors.surface-sheet}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
    height: "32px"
  button-outline:
    backgroundColor: "{colors.surface-sheet}"
    textColor: "{colors.ink-carbon}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
    height: "32px"
  button-destructive:
    backgroundColor: "{colors.crimson-danger}"
    textColor: "{colors.surface-sheet}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
    height: "32px"
  button-destructive-outline:
    backgroundColor: "rgba(201, 42, 42, 0.06)"
    textColor: "{colors.crimson-danger}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "6px 10px"
    height: "28px"
  button-auth-lg:
    backgroundColor: "{colors.ocean-primary}"
    textColor: "{colors.surface-sheet}"
    typography: "{typography.title}"
    rounded: "{rounded.md}"
    padding: "0px 16px"
    height: "40px"
  input-console:
    backgroundColor: "{colors.surface-sheet}"
    textColor: "{colors.ink-carbon}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "4px 10px"
    height: "32px"
  nav-item-active:
    backgroundColor: "{colors.ocean-wash}"
    textColor: "{colors.ocean-ink}"
    typography: "{typography.nav}"
    rounded: "{rounded.md}"
    padding: "0px 12px"
    height: "36px"
---

# Design System: EdgeBase Control Plane

## Overview

**Creative North Star: "The Technical Spec Sheet"**

EdgeBase pairs calm Dieter Rams / Braun product catalog clarity with Tailscale-style tonal consistency and structured tree hierarchy. Unauthenticated workflows open on an uncluttered centered `440px` specification sheet above a subtle stone canvas (`#F3F2EE` light / `#111214` dark); authenticated operators transition into a unified tonal workspace where pure white navigation rails (`#FFFFFF`) meet warm stone paper in Light mode, and dark obsidian rails (`#141518`) meet matte graphite (`#111214` / `#181A1D`) in Dark mode.

Ocean Blue (`#0369A1` light / `#0EA5E9` dark) anchors interactive commitments by default, while `src/lib/accent.ts` allows live selection of 8 contrast-verified presets (`ocean`, `cobalt`, `vermilion`, `emerald`, `teal`, `indigo`, `amber`, `obsidian`) or any custom `#RRGGBB` hex code with automatic WCAG AA (`>= 4.6:1`) surface ink adaptation. Destructive actions (`Revoke all`, `Remove`, `Unlink`, `Delete`) always stand apart in semantic Crimson (`#C92A2A` / `#F06565`), and every page honors `System / Light / Dark` mode with `script-src 'self'` CSP compliance.

**Key Characteristics:**
- Unified tonal parity (`#FFFFFF` rail + `#F3F2EE` canvas in Light; `#141518` rail + `#111214` canvas in Dark) with zero dark-sidebar-on-light-mode split contrast.
- Default Ocean Blue (`#0369A1` / `#0EA5E9`) primary chroma plus live swatch + hex accent customization saved per browser (`edgebase:accent`).
- Tailscale-inspired collapsible sidebar hierarchy (`Users`, collapsible `Push notifications` tree with vertical hairline guide, `Account & Security`) and clean geometric iconography (`lucide-react` strokes + 2x2 `BrandMark`, zero bell glyphs).
- Optical-matched `Google`, `GitHub`, and `Apple` federation icons arranged in centered symmetric columns, and one-click WebAuthn passkey enrollment without pre-registration label modals.

## Colors

Warm archival stone (`#F3F2EE`) and pure white (`#FFFFFF`) surfaces frame deep carbon (`#191A1C`) ink in Light mode, inverting to `#111214` / `#141518` / `#181A1D` graphite layers in Dark mode, with Ocean Blue (`#0369A1` / `#0EA5E9`) default primary and strictly semantic status colors.

### Primary (Default Accent: Ocean Blue)
- **Ocean Primary** (`#0369A1` light / `#0EA5E9` dark): Solid primary commit buttons (`Sign in`, `Create account`, `Send reset link`, `New push`, `New template`, `Send push`), checked checkboxes, active step bars, focus outlines, and caret tint. Overridden dynamically when the user selects another preset or custom hex in `ThemeCustomizer`.
- **Ocean Ink** (`#075985` light / `#38BDF8` dark): Inline text links (`Forgot password?`), active sidebar icons, and inline `{{variable}}` template tokens. Dynamically derived via `ensureSurfaceInkContrast` for arbitrary custom colors to preserve `>= 4.6:1` legibility.
- **Ocean Wash** (`#E6F0F6` light / `#163342` dark): Soft translucent accent wash for active sidebar nav leaves, `Admin` role chips, active Auth mode step tabs, and text selection (`::selection`).

### Neutral
- **Canvas Stone / Graphite** (`#F3F2EE` light / `#111214` dark): Page canvas background.
- **Specification Sheet / Card** (`#FFFFFF` light / `#181A1D` dark): Ledger containers, auth cards, data tables, and summary strips.
- **Rail Surface** (`#FFFFFF` light / `#141518` dark): `248px` desktop sidebar matching active mode luminance ("all light in Light mode, all dark in Dark mode").
- **Hairline Borders** (`#DCDAD3` light / `#2B2E35` dark): `1px` dividers across cards, tables, metric cells, and tree lines.
- **Control Borders** (`#C6C3B9` light / `#3A3E48` dark): Default strokes on text inputs, selects, and secondary outline buttons.
- **Ink Tokens** (`#191A1C` / `#5E5D58` light; `#F0EFEA` / `#9C9E9A` dark): High-contrast primary copy and muted secondary labels.

### Semantic Status
- **Emerald Status** (`#0F7B55` light / `#34D399` dark): `Active`, `Current`, `This browser`, `Linked`, completed multi-step progress indicators, and delivered push meter fills.
- **Amber Status** (`#B45309` light / `#FBBF24` dark): `Unverified`, `Scheduled`, `Marketing`, and inline `ASN / country changed` session telemetry alerts.
- **Crimson Danger** (`#C92A2A` light / `#F06565` dark): Solid crimson (`#C92A2A`) for `Revoke all` / confirmation buttons and crimson-tinted outline (`destructive-outline`) for row `Remove` / `Unlink` / `Revoke` / trash buttons, `Banned` pills, failed push metrics, and `role="alert"` banners.

### Named Rules
**The Unified Tonal Parity Rule.** Sidebar navigation, header chrome, and workspace surfaces stay strictly within the active Light (`#FFFFFF` / `#F3F2EE`) or Dark (`#141518` / `#111214`) polarity—never mixing a dark architectural rail onto a light workspace.

**The Live AA Accent Rule.** User-selected primary accent colors apply live across CSS custom properties (`--primary`, `--primary-foreground`, `--primary-ink`, `--accent`, `--accent-foreground`, `--ring`, `--sidebar-primary`) with computed contrast guarantees (`>= 4.6:1` on surface text and `#FFFFFF` / `#141518` button ink).

**The Destructive Separation Rule.** Irreversible removal, session revocation, account unlinking, banning, and deletion actions render in semantic Crimson (`destructive` solid or `destructive-outline`), clearly distinguished from neutral configuration edits.

## Typography

**Display & UI Font:** `-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` (zero-CDN CSP-compliant native sans with `"cv02", "cv03", "cv04", "cv11"` OpenType disambiguation).
**Mono Font:** `"SF Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace` with `tabular-nums`.

- **Display (`22px`, `600`, `1.25` line-height, `-0.025em` tracking):** `AuthShell` titles and console `PageHeader` titles.
- **Wordmark (`15px` auth / `14px` console, `600`):** Brand title next to geometric 2x2 `BrandMark`.
- **Title / Large CTA (`14px`, `500`–`600`):** Modal dialog titles (`DialogTitle`) and `size="lg"` auth submission buttons.
- **Nav (`13.5px`, `400`–`500`):** Top-level console sidebar items (`Users`, `Push notifications`, `Account & Security`).
- **Body (`13px`, `400`–`500`, `1.5` line-height):** Standard console copy, form labels (`Label`), table rows, nested child links (`Push notifications` leaves), and inputs.
- **Caption (`12px`):** Secondary descriptions, inline helper text, template bodies, and timestamps.
- **Label (`11px`, `500`):** Table column headers, `Status` badges, metric labels, and progress step tabs.
- **Micro (`10px`, `500`, mono):** Capacity tags (`CAP 20`, `CAP 50`, `CAP 500`), percentage readouts, and `Admin` rail chip.

## Layout

- **Auth Portal Viewport:** Slim top header (`BrandMark + appName` left, `AuthAppearanceControl` right) framing a centered single-column `max-w-[440px]` `bg-card` specification card—free of decorative side marketing panels. Uses clean mode switcher tabs (`Sign in` | `Create account`) and locked-geometry 3-step `<ol aria-label="Progress">` strips (`#forgot-password`, `#reset-password`, `#two-factor`).
- **Console Two-Column Shell (`>= 768px`):** `248px minmax(0, 1fr)` grid pairing a sticky `100vh` left navigation rail with a centered `max-w-[1180px]` operational workspace (`px-4 py-5 sm:px-8 sm:py-7`).
- **Responsive Mobile (`< 768px`):** Top bar pairs `BrandMark + appName` with the compact `AccountMenu` trigger, followed by a single horizontally scrollable row of all five route pills (`Users`, `Send`, `History`, `Templates`, `Security`).
- **Summary & Ledger Composition:** Metrics sit in 4-column `divide-x` strips (`Total accounts`, `Active`, `2FA enrolled`, `Selected recipients` / `Batches`, `Delivered`, `Failed`, `Opened`) with crisp 3px proportional progress fills; records render in `1px`-bordered `bg-card` ledgers without boxed noise inside rows.

## Elevation & Depth

Flat tonal contrast and `1px` structural hairlines replace heavy drop shadows across all in-flow operational views. Subtle multi-layer ambient elevation is reserved strictly for:
- **Centered Auth Sheet:** `0 10px 32px -12px rgba(25, 26, 28, 0.09), 0 1px 3px rgba(25, 26, 28, 0.04)` light (`0 22px 52px -16px rgba(0, 0, 0, 0.65)` dark).
- **Portaled Menus & Dialogs:** Radix `DropdownMenuContent`, `SelectContent`, and `DialogContent` over `bg-black/55` backdrop.

## Shapes

Sharp engineering tolerances bounded between `2px` (`rounded-xs`) and `6px` (`rounded-lg`):
- `2px`: Inline swatch previews and 3px summary meter bars.
- `3px`: Checkboxes and theme swatch square tiles.
- `4px` (`--radius-md` default): Standard buttons, inputs, status badges, and nav items.
- `6px` (`--radius-lg`): Outer ledger panels, dialogs, and centered auth sheets.

## Components

- **Federated Auth Row (`ProviderButtons.tsx`):** Centered `Continue with a passkey` button followed by a balanced multi-column grid (`grid-cols-3` when 3 providers configured, `grid-cols-2` when 2, full-width for 1) housing optically balanced Google, GitHub, and Apple icons (`Apple` cropped to `viewBox="2.6 2.6 19.2 19.2"` to match peer glyphs).
- **Theme Customizer (`ThemeCustomizer.tsx`):** Compact `AuthAppearanceControl` dropdown in auth headers, matching `Appearance + Primary color` menu in `AccountMenu`, and full `Interface preferences` card in `Account.tsx` pairing `System / Light / Dark` buttons with 8 preset swatches + native `<input type="color">` + hex validation input.
- **Direct WebAuthn Passkeys (`Account.tsx`, `TwoFactorSetup.tsx`):** Single-click `Add passkey` and `Enroll FIDO2 passkey` immediately invoke `navigator.credentials.create()` with post-registration AAGUID auto-labeling and inline `Rename` support—zero pre-registration label prompts.
- **Clean Typography Tables (`Templates.tsx`, `Users.tsx`):** Borderless monospace template keys and locale lists, accent-tinted inline `{{variable}}` text (zero pill boxes around every token), borderless copyable ID buttons, and clean role/status scanning.
- **Session Telemetry (`SessionCard.tsx`):** Renders `Origin -> Current` ASN/location hop comparison strips inline whenever `networkShifted` is true, with crimson `Revoke` / `Remove` actions.

## Do's and Don'ts

### Do:
- **Do** keep light mode all-light (`#FFFFFF` rail + `#F3F2EE` ground) and dark mode all-dark (`#141518` rail + `#111214` ground).
- **Do** route all user-facing theme & accent changes through `setThemePreference` / `setAccentPreference` so CSS variables update synchronously with computed AA contrast.
- **Do** mark all destructive actions (`Revoke all`, `Remove`, `Unlink`, `Revoke`, `Delete`, `Ban`) with `variant="destructive"` or `variant="destructive-outline"` crimson styling.
- **Do** trigger native WebAuthn passkey prompts directly on click without modal label prompts.

### Don't:
- **Don't** add marketing hero copy or spec side panels next to centered authentication cards.
- **Don't** surround template keys, locale tags, user IDs, or `{{variable}}` placeholders with redundant bordered micro-boxes.
- **Don't** use `BellRing` icons or eyebrow kickers above headings.
- **Don't** reference external fonts, scripts, or CDN assets outside self-hosted bundles under the Worker CSP.
