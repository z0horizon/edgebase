---
name: "EdgeBase Admin Console"
description: "Precision D1 operational ledger and Universal Login control plane for Cloudflare Workers."
colors:
  cobalt-primary: "#2554d9"
  cobalt-primary-dark: "#2f5ee5"
  cobalt-ink: "#1e46b8"
  cobalt-ink-dark: "#84a9ff"
  cobalt-wash: "#edf2fd"
  cobalt-wash-dark: "#192236"
  cobalt-wash-ink: "#1b3ea8"
  cobalt-wash-ink-dark: "#a6c4ff"
  focus-ring-dark: "#5b85ff"
  canvas-paper: "#f8f9fb"
  canvas-obsidian: "#0b0c0e"
  surface-sheet: "#ffffff"
  surface-ledger-dark: "#111317"
  surface-popover-dark: "#15181e"
  rail-surface: "#f1f3f6"
  rail-obsidian: "#08090b"
  rail-active: "#e4e8ef"
  rail-active-dark: "#161920"
  surface-muted: "#f2f4f7"
  surface-muted-dark: "#15181f"
  surface-secondary: "#eff1f5"
  surface-secondary-dark: "#1a1d24"
  ink-carbon: "#111318"
  ink-chalk: "#eceef2"
  ink-slate: "#555d6d"
  ink-slate-dark: "#969daa"
  border-hairline: "#e2e5eb"
  border-hairline-dark: "#22262f"
  border-rail: "#dfe3ea"
  border-rail-dark: "#1d2028"
  border-control: "#cfd5df"
  border-control-dark: "#2d323e"
  emerald-status: "#0f7b55"
  emerald-status-dark: "#34d399"
  amber-status: "#b45309"
  amber-status-dark: "#fbbf24"
  crimson-danger: "#c92a2a"
  crimson-danger-dark: "#f06565"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, Inter, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 400
    lineHeight: 1.25
    letterSpacing: "-0.01em"
    fontFeature: "\"cv02\", \"cv03\", \"cv04\", \"cv11\""
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, Inter, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "-0.025em"
    fontFeature: "\"cv02\", \"cv03\", \"cv04\", \"cv11\""
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, Inter, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.375
    letterSpacing: "-0.01em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, Inter, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0em"
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, Inter, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "0.01em"
  mono:
    fontFamily: "SF Mono, JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
    fontSize: "0.6875rem"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "0em"
    fontFeature: "\"tnum\""
rounded:
  xs: "2px"
  sm: "4px"
  auth: "5px"
  md: "6px"
  lg: "8px"
spacing:
  2xs: "4px"
  xs: "6px"
  sm: "10px"
  md: "14px"
  lg: "16px"
  xl: "20px"
  2xl: "28px"
  3xl: "40px"
components:
  button-primary:
    backgroundColor: "{colors.cobalt-primary}"
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
  button-secondary:
    backgroundColor: "{colors.surface-secondary}"
    textColor: "{colors.ink-carbon}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
    height: "32px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-slate}"
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
  button-auth-continue:
    backgroundColor: "{colors.cobalt-primary}"
    textColor: "{colors.surface-sheet}"
    rounded: "{rounded.sm}"
    padding: "0px 16px"
    height: "50px"
  input-floating:
    backgroundColor: "{colors.surface-sheet}"
    textColor: "{colors.ink-carbon}"
    rounded: "{rounded.sm}"
    padding: "0px 14px"
    height: "52px"
  input-console:
    backgroundColor: "{colors.surface-sheet}"
    textColor: "{colors.ink-carbon}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "4px 10px"
    height: "32px"
  badge-primary:
    backgroundColor: "{colors.cobalt-wash}"
    textColor: "{colors.cobalt-wash-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "2px 6px"
  badge-secondary:
    backgroundColor: "{colors.surface-secondary}"
    textColor: "{colors.ink-carbon}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "2px 6px"
  badge-success:
    backgroundColor: "rgba(16, 185, 129, 0.1)"
    textColor: "{colors.emerald-status}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "2px 6px"
  badge-warning:
    backgroundColor: "rgba(245, 158, 11, 0.1)"
    textColor: "{colors.amber-status}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "2px 6px"
  badge-destructive:
    backgroundColor: "rgba(201, 42, 42, 0.1)"
    textColor: "{colors.crimson-danger}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "2px 6px"
  nav-item-active:
    backgroundColor: "{colors.rail-active}"
    textColor: "{colors.ink-carbon}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0px 10px"
    height: "32px"
  table-ledger-row:
    backgroundColor: "{colors.surface-sheet}"
    textColor: "{colors.ink-carbon}"
    typography: "{typography.body}"
    padding: "10px 14px"
---

# Design System: EdgeBase Admin Console

## Overview

**Creative North Star: "The Architectural Security Ledger"**

EdgeBase Admin Console speaks in the quiet, high-density dialect of enterprise infrastructure and identity tooling—aligned with Cloudflare Dashboard, WorkOS, Stripe Dashboard, and Auth0 Universal Login. The system reconciles two distinct operational moments within one coherent visual language: an unhurried, high-trust authentication sheet for credential and second-factor verification, and a crisp, zero-chrome operational workspace where D1 accounts, WebAuthn passkeys, ASN/ISP session origins, and FCM delivery batches read like entries in an engineering ledger.

Every surface is engineered for sustained legibility across bright daytime offices and dark late-night incident windows under a strict zero-CDN Content Security Policy (`script-src 'self'`). Hierarchy comes from stepped carbon-slate neutrals, continuous `1px` hairlines, compact `13px` body rhythm, and tabular monospace telemetry rather than ornamental containers. The system explicitly rejects decorative AI-era tropes: no glowing icon tiles above headings, no invented brand marks, no purple or electric-blue gradients, no fake live-status indicator dots in navigation chrome, no segmented three-icon theme boxes, and no nested card-in-card clutter.

**Key Characteristics:**
- Dual-pace cadence pairing spacious `400px` Universal Login sheets (`52px` border-notched floating inputs) with dense `13px` operational tables and key-value ledgers.
- Carbon-slate architectural neutrals across full-parity Light (`#f8f9fb` canvas, `#ffffff` sheets) and Dark (`#0b0c0e` canvas, `#111317` sheets) themes.
- Single cobalt-indigo interactive voice (`#2554d9` light / `#2f5ee5` dark) backed by strictly semantic emerald, amber, and crimson telemetry tokens.
- Clamped `2px`–`8px` geometry (`6px` console default, `4px`–`5px` authentication sheet) with `1px` structural hairlines instead of ambient card shadows.
- Zero-CDN system neo-grotesque and monospace stacks tuned with OpenType disambiguation (`cv02`, `cv03`, `cv04`, `cv11`) and `tabular-nums` alignment.

## Colors

A disciplined carbon-slate neutral architecture punctuated by a single cobalt-indigo action accent and three semantic telemetry hues across full-parity light and dark scenes.

### Primary
- **Cobalt Primary** (`#2554d9` light / `#2f5ee5` dark): Primary commit buttons (`Continue`, `Send push`, `New template`), checked checkbox fills, open-rate progress bars, text carets, and light-mode keyboard focus rings.
- **Cobalt Ink** (`#1e46b8` light / `#84a9ff` dark): Inline text links, active sidebar navigation icons, and the focused border-notched floating label on authentication inputs.
- **Cobalt Wash** (`#edf2fd` light / `#192236` dark): Soft tint behind `Admin` role badges, active locale preview tabs, selected table rows (`55%` opacity), and text `::selection` highlights.
- **Cobalt Wash Ink** (`#1b3ea8` light / `#a6c4ff` dark): High-contrast foreground text paired exclusively with Cobalt Wash fills.
- **Focus Ring Dark** (`#5b85ff`): Luminous cobalt focus outline reserved for dark-mode `:focus-visible` rings on controls and sidebar items where `#2f5ee5` needs extra edge separation against `#0b0c0e`.

### Neutral
- **Canvas Paper / Canvas Obsidian** (`#f8f9fb` light / `#0b0c0e` dark): Root `<main>` workspace canvas and recessed segmented-control tracks.
- **Surface Sheet / Surface Ledger Dark** (`#ffffff` light / `#111317` dark): Primary surface for operational tables, bordered section ledgers, text inputs, outline buttons, and authentication sheets (`#ffffff` also serves as primary button ink in both themes).
- **Surface Popover Dark** (`#15181e`): Elevated dark-mode surface for floating `DropdownMenu` and `Select` menus (`#ffffff` in light mode).
- **Rail Surface / Rail Obsidian** (`#f1f3f6` light / `#08090b` dark): Sticky `224px` left navigation rail, recessed slightly cooler in light mode and deeper than canvas in dark mode.
- **Rail Active** (`#e4e8ef` light / `#161920` dark): Selected navigation item fill, hover wash (`60%` opacity), and open account-menu trigger background inside the sidebar.
- **Surface Muted** (`#f2f4f7` light / `#15181f` dark): Translucent header washes (`70%` on `thead`, `35%` on section headers and form footers) and subtle table row hover states (`45%` opacity).
- **Surface Secondary** (`#eff1f5` light / `#1a1d24` dark): Neutral `User` / `Transactional` badge fills, dropdown/select item focus highlights, outline button hover states, and empty progress tracks.
- **Ink Carbon / Ink Chalk** (`#111318` light / `#eceef2` dark): Primary typography for headings, account emails, active navigation labels, and primary key-value data.
- **Ink Slate** (`#555d6d` light / `#969daa` dark): Secondary metadata, table column headers, inactive navigation links, input placeholders, and monospace network telemetry.
- **Border Hairline** (`#e2e5eb` light / `#22262f` dark): Default `1px` structural border around ledgers, modals, popovers, posture cells, and table row dividers.
- **Border Rail** (`#dfe3ea` light / `#1d2028` dark): Dedicated `1px` boundary separating the sidebar rail, brand bar, nav groups, and account footer.
- **Border Control** (`#cfd5df` light / `#2d323e` dark): Higher-contrast `1px` resting stroke on console inputs, textareas, checkboxes, select triggers, and outline buttons so interactive fields read distinctly against card surfaces.
- **Emerald Status** (`#0f7b55` light / `#34d399` dark): Semantic confirmation for `Active` verified accounts, `Current` sessions, `Linked` OAuth providers, and delivered push counts.
- **Amber Status** (`#b45309` light / `#fbbf24` dark): Semantic caution for `ASN / country changed` session origin shifts, `Unverified` emails, `Scheduled` dispatches, `Marketing` audience badges, and unconfigured-secret notices.
- **Crimson Danger** (`#c92a2a` light / `#f06565` dark): Semantic danger for `Banned` accounts, failed push counts, inline `role="alert"` form errors, destructive menu actions (`Log out`, `Ban user`), and solid destructive confirmation buttons (`#c92a2a`).

### Named Rules
**The Scarce Cobalt Rule.** Cobalt Primary (`#2554d9` light / `#2f5ee5` dark) appears on at most one primary commit action per view alongside checked form states, active progress fills, and focus rings; secondary toolbar and row actions always step back to `outline` or `ghost` neutrals.

**The Semantic-Only Chroma Rule.** Emerald (`#0f7b55` / `#34d399`), amber (`#b45309` / `#fbbf24`), and crimson (`#c92a2a` / `#f06565`) encode live account, security, or delivery state exclusively—never decorative tags, avatars, or illustration accents.

**The Stepped-Luminance Dark Rule.** Dark mode establishes hierarchy by stepping surface luminance—from `#08090b` rail to `#0b0c0e` canvas, `#111317` ledger, and `#15181e` popover—paired with `1px` `#22262f` hairlines rather than glowing borders or heavy drop shadows.

## Typography

**Display Font:** `-apple-system, BlinkMacSystemFont, "Inter"` (with `"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` fallback)
**Body Font:** `-apple-system, BlinkMacSystemFont, "Inter"` (with `"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` fallback)
**Label/Mono Font:** `"SF Mono", "JetBrains Mono"` (with `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace` fallback)

**Character:** A crisp, zero-network-latency neo-grotesque UI voice paired with technical monospace telemetry to satisfy the Worker's self-contained CSP without external font requests. Global OpenType disambiguation (`"cv02", "cv03", "cv04", "cv11"`) and antialiased rendering keep dense email addresses, user IDs, and one-time codes unmistakable at small sizes.

### Hierarchy
- **Display** (`400`, `24px` / `1.5rem`, `1.25` line-height, `-0.01em` tracking): Centered authentication and second-factor enrollment headings (`Welcome`, `Verify your identity`, `Secure your account`) using calm regular weight rather than heavy marketing display bolds.
- **Headline** (`600`, `18px` / `1.125rem`, `1.35` line-height, `-0.025em` tracking): Primary console view titles in `PageHeader` (`Users`, `Send push`, `Sent pushes`, `Templates`, `Account & Security`).
- **Title** (`600`, `14px` / `0.875rem` in dialogs and rail wordmark; `13px` / `0.8125rem` in bordered ledger headers, `1.375` line-height): Modal headings (`DialogTitle`), sidebar `EdgeBase` wordmark, and section headers (`Passkeys`, `Active sessions`).
- **Body** (`400`–`500`, `13px` / `0.8125rem`, `1.5` line-height; `15px` inside Universal Login inputs and buttons; `12px` / `0.75rem` secondary descriptions capped at `42rem` / `~65ch`): Default operational prose, table cells, form controls, dropdown items, and navigation links.
- **Label** (`500`, `11px` / `0.6875rem`, `1.0` line-height, `0.01em` tracking, sentence case): Table column headers (`TableHead`), semantic status `Badge` pills, and security-posture micro-labels.
- **Mono** (`400`–`500`, `11px`–`12px`, `1.4` line-height, `tabular-nums`): Truncated user and passkey IDs, Cloudflare ASN/ISP/IP origin telemetry, `{{variable}}` template placeholders, TOTP secrets, character counters, and idempotency keys.

### Named Rules
**The Tabular Telemetry Rule.** Every numeric count, timestamp, batch metric, character limit (`12/64`), and TOTP verification input enforces `font-variant-numeric: tabular-nums` (`0.25em` tracking on 6-digit TOTP fields) so vertical columns and live counters never shift width.

**The Sentence-Case Chrome Rule.** All page titles, table headers, badges, buttons, and section labels use natural sentence case; uppercase tracking is forbidden across console chrome except for the single `12px` (`0.06em` tracked) `"OR"` divider inside authentication sheets.

## Layout

EdgeBase Admin separates unauthenticated verification from authenticated operations through two purpose-built spatial models:

- **Authentication Sheet Viewport:** Full-height centered canvas (`min-h-screen`, `display: grid`, `place-items: center`, `16px` horizontal by `40px` vertical viewport padding) holding a single `400px` max-width sheet (`28px` horizontal / `36px` vertical padding on mobile; `40px` × `40px` at `>=640px`). Form fields stack with `16px` (`gap-4`) rhythm above a `50px` full-width primary submit button and `10px`-gapped (`gap-2.5`) alternative factor buttons.
- **Console Two-Column Shell (`>=768px`):** CSS Grid (`224px minmax(0, 1fr)`) pairing a sticky `100vh` left navigation rail (`border-right: 1px solid`) with a fluid workspace container capped at `1140px` (`mx-auto`, `16px` × `20px` padding below `640px`; `32px` × `28px` at `>=640px`). There is no top application status bar; every view opens directly with `PageHeader` (`20px` bottom margin).
- **Responsive Collapse (`<768px`):** The `224px` rail collapses into a stacked top header (`48px` wordmark + compact bordered account trigger) over a horizontally scrollable single-row navigation strip (`padding: 8px 10px`) that swaps full titles for concise labels (`Users`, `Send`, `Pushes`, `Templates`).
- **Operational Density & Split Composition:** Multi-section views stack with `20px` (`gap-5`) vertical spacing. Summary posture strips use 1-column (`<640px`), 2-column (`>=640px`), or 4-column (`>=1024px`) hairline-divided grids (`12px` × `16px` cell padding). Complex authoring (`Send push`) splits at `>=1024px` into a primary bordered form ledger and a sticky (`top: 24px`) right-hand `Payload inspector` column.

**The Continuous-Ledger Rule.** Related records—accounts, active sessions, passkeys, OAuth providers, trusted devices, and templates—always inhabit a single `1px`-bordered `bg-card` container subdivided by full-width `1px` `divide-y` hairlines, never individual floating cards per item or nested bordered boxes inside cards.

## Elevation & Depth

Operational views are **flat by default**, relying on tonal surface contrast (`#f8f9fb` vs. `#ffffff` in light; `#0b0c0e` vs. `#111317` in dark), `1px` structural hairlines, and subtle muted header washes (`35%`–`70%` `--muted`) to separate regions without visual noise. Drop shadows appear strictly when a surface floats above the document plane or stands alone on the authentication canvas.

### Shadow Vocabulary
- **Auth Sheet Light** (`box-shadow: 0 12px 40px -10px rgba(15, 23, 42, 0.12), 0 2px 6px rgba(15, 23, 42, 0.04)`): Soft architectural lift for the standalone `400px` Universal Login card against the `135deg` split `#f8f9fb` / `#eef0f4` canvas.
- **Auth Sheet Dark** (`box-shadow: 0 20px 50px -12px rgba(0, 0, 0, 0.65)`): Deep grounding shadow beneath the dark authentication card on `#0b0c0e` canvas, reinforced by a `1px` `#22262f` border.
- **Popover & Menu** (`box-shadow: 0 8px 24px -6px rgba(0, 0, 0, 0.18)`): Crisp separation for `DropdownMenuContent` and `SelectContent` portaled above dense table rows.
- **Modal Dialog** (`box-shadow: 0 16px 40px -10px rgba(0, 0, 0, 0.28)`): High-elevation shadow for `DialogContent` and `AlertDialogContent`, paired with a `rgba(0, 0, 0, 0.55)` (`bg-black/55`) viewport backdrop.
- **Notification Specimen** (`box-shadow: 0 2px 8px -2px rgba(0, 0, 0, 0.08)`): Low-profile elevation isolating the simulated device notification preview inside its muted inspector well.

### Named Rules
**The Flat-Workspace Rule.** In-flow tables, section containers, metric strips, navigation items, and buttons carry zero `box-shadow` in resting, hover, or active states; shadows belong exclusively to portaled overlays, authentication sheets, and the isolated notification preview card.

## Shapes

Corner geometry is crisp, technical, and deliberately clamped: `--radius-lg` through `--radius-4xl` top out at `8px` (`0.5rem`), preventing pill-shaped buttons or soft consumer-app rounding from entering the system.

- **Micro Tokens (`2px` / `rounded-xs`):** Inline `{{variable}}` template placeholder highlights and `6px`-tall open-rate progress tracks.
- **Checkboxes (`3px`):** `14px` × `14px` (`size-3.5`) selection checkboxes in tables and forms.
- **Compact Chips, Menu Rows & Auth Controls (`4px` / `--radius-sm`):** Status `Badge` pills, copyable user-ID chips, dropdown/select menu items, segmented radio options, and Universal Login `52px` floating inputs and `50px` action buttons.
- **Authentication Sheet (`5px`):** Outer corner radius of the `400px` Universal Login card.
- **Console Standard (`6px` / `--radius-md`):** Default radius for console `Button`, `Input`, `Textarea`, `SelectTrigger`, sidebar navigation links, `DropdownMenuContent`, `DialogContent`, and `overflow-hidden` table/section ledgers.
- **Ceiling (`8px` / `--radius-lg`):** Hard upper bound on container rounding across the entire application; `9999px` circles appear only on the `6px` status indicator dot inside `Active` verification badges.
- **Hairline & Stroke Pairing:** Structural containers use `1px solid` `#e2e5eb` (`#22262f` dark) with `overflow: hidden` so internal header washes clip cleanly at the corner radius, while interactive inputs and outline buttons step border contrast up to `#cfd5df` (`#2d323e` dark).

## Components

### Buttons
Crisp, non-bouncy operational triggers with `150ms ease-out` color transitions and zero vertical translation on hover.
- **Shape & Sizing:** `6px` radius (`rounded-md`) across four console heights—`xs` (`24px`, `12px` text, `0 8px` padding), `sm` (`28px`, `12px` text, `0 10px` padding), `default` (`32px`, `13px` medium text, `6px 12px` padding), and `lg` (`36px`, `0 16px` padding)—plus square icon buttons (`24px`, `28px`, `32px`, `36px`) with `14px` (`size-3.5`) SVGs. Authentication sheets use full-width `50px` buttons at `4px` radius and `15px` text.
- **Primary (`default`):** Cobalt Primary fill (`#2554d9` light / `#2f5ee5` dark) with `#ffffff` medium text; darkens to `90%` opacity on hover.
- **Outline (`outline`):** Surface Sheet fill (`#ffffff` / `#111317`) with `1px solid` Border Control (`#cfd5df` / `#2d323e`) and Ink Carbon/Chalk text; shifts to `75%` Surface Secondary fill and Border Hairline stroke on hover.
- **Secondary, Ghost & Destructive:** `secondary` uses `#eff1f5` / `#1a1d24` fill; `ghost` rests transparent in Ink Slate (`#555d6d` / `#969daa`) and fills with Surface Secondary on hover; `destructive` uses solid Crimson Danger (`#c92a2a`) with `#ffffff` label for irreversible confirmations.
- **Focus & Disabled:** `:focus-visible` applies a `2px` ring at `35%` `--ring` opacity (`#2554d9` light / `#5b85ff` dark); disabled controls drop to `50%` opacity with `pointer-events: none`.

### Chips
Compact `4px`-radius (`rounded-sm`) inline status pills that communicate role, factor, and telemetry state without dominating table rows.
- **Style:** `11px` (`font-weight: 500`, `line-height: 1`), `2px 6px` padding (`px-1.5 py-0.5`), `4px` internal gap, and a `1px` translucent semantic border (`25%`–`30%` opacity).
- **Variants:** `default` (`#edf2fd` / `#192236` wash with `#1b3ea8` / `#a6c4ff` ink for `Admin`), `secondary` (`#eff1f5` / `#1a1d24` for `User` and `Transactional`), `success` (`10%` emerald tint with optional `6px` emerald dot for `Active`, `Current`, `Linked`), `warning` (`10%` amber tint for `ASN / country changed`, `Unverified`, `Scheduled`, `Marketing`), `destructive` (`10%`–`15%` crimson tint for `Banned`), and `outline` (card fill + `1px` hairline + slate text for `2FA: totp` and `You`).
- **Copyable Mono Chips:** Truncated IDs (`usr_…`) render in `11px` monospace inside `4px`-radius `1px`-bordered `50%` muted pills (`2px 6px` padding) with a `10px` trailing copy icon that brightens to primary ink on hover.

### Cards / Containers
Flat `1px`-bordered architectural ledgers that organize dense operational state without nested boxes.
- **Corner & Border:** `6px` radius (`rounded-md`), `1px solid` `#e2e5eb` (`#22262f` dark), `bg-card` (`#ffffff` / `#111317`), `overflow: hidden`.
- **Section Header Bar:** `12px 16px` (`px-4 py-3`) header strip with `1px` bottom border and `35%` muted wash (`bg-muted/35`), pairing a `13px` semibold title and `12px` slate subtitle on the left with a single `sm` outline action button on the right.
- **Ledger Rows & SessionCard:** Internal items stack via `1px` `divide-y` hairlines at `12px 16px` padding, pairing device/passkey title + status badges on line one, `11px` monospace ASN/ISP/IP origin telemetry on line two, `11px` `tabular-nums` lifecycle timestamps on line three, and right-aligned `sm` outline actions.
- **Dialogs:** `DialogContent` (`max-w-lg` / `512px`, `20px` padding, `6px` radius, `1px` border, Modal Dialog shadow) over a `55%` black scrim with a `24px` (`size-6`) top-right close button.

### Inputs / Fields
Two context-specific field primitives tailored to operational density vs. focused credential entry.
- **Console Input, Select & Textarea:** `32px` standard height (`28px` compact toolbar filter), `6px` radius, `1px solid` `#cfd5df` (`#2d323e` dark), `#ffffff` / `#111317` fill, `4px 10px` padding, and `13px` text (`#555d6d` / `#969daa` placeholder). `:focus-visible` shifts border to `--ring` with a `2px` `25%`-opacity outer ring; `aria-invalid` shifts border and `20%` ring to Crimson Danger.
- **Border-Notched Floating Input (`FloatingInput`):** Reserved exclusively for Universal Login (`SignIn` and `TwoFactorSetup`). `52px` height, `4px` radius, `0 14px` padding (`44px` right padding when housing a `32px` password-visibility toggle), and `15px` foreground text. Its `<label>` rests vertically centered at `15px` in Ink Slate when empty and transitions over `150ms` to `top: 0` (`-translate-y-1/2`, `12px`, `4px` horizontal `bg-card` notch mask) in Cobalt Ink (`#1e46b8` / `#84a9ff`) with a `1px` Cobalt Primary border + `1px` ring on focus.

### Navigation
Quiet, typographic rail navigation with integrated account and theme controls.
- **Desktop Left Rail (`224px`):** Sticky `100vh` `aside` in `#f1f3f6` (`#08090b` dark) with `1px` `#dfe3ea` (`#1d2028` dark) right border. Opens with a `48px` header (`14px` horizontal padding) holding the `14px` semibold `EdgeBase` wordmark—no logo glyph, no fake status badge.
- **Section Links:** `32px` height (`28px` on mobile), `6px` radius, `0 10px` padding, `8px` icon-to-label gap, `13px` text, and `14px` (`size-3.5`) Lucide icons. Operations views (`Users`, `Send push`, `Sent pushes`, `Templates`) sit above a `1px` hairline divider and `Account & Security`. Inactive links render in Ink Slate and brighten to `60%` Rail Active on hover; the active route uses solid Rail Active (`#e4e8ef` / `#161920`), `500` weight Ink Carbon/Chalk text, and a Cobalt Ink (`#1e46b8` / `#84a9ff`) icon.
- **Account Popover Trigger:** Pinned to the rail footer inside an `8px`-padded `1px` top-bordered slot (`36px` height, `100%` width, truncated operator email + `14px` `ChevronsUpDown` icon). Opens a `224px` (`w-56`) `DropdownMenuContent` containing operator name/email, `Account & Security`, an `Appearance` radio group (`System`, `Light`, `Dark`), and a destructive `Log out` item.

### Operational Data Tables & Payload Inspector
The core operational workhorses of the console.
- **Ledger Table (`Table`):** Wrapped in a `6px`-radius `1px`-bordered `bg-card` container, often preceded by a `10px 14px` (`px-3.5 py-2.5`) filter and batch-action toolbar (`1px` bottom border, `tabular-nums` record count on the right). `TableHeader` uses a `32px`-tall `70%` muted wash (`bg-muted/70`) with `11px` medium sentence-case `TableHead` labels (`0 14px` padding). `TableRow` transitions in `100ms` to `45%` Surface Muted on hover and `55%` Cobalt Wash when selected (`data-state="selected"`), with `10px 14px` (`px-3.5 py-2.5`) `TableCell` alignment and zero bottom border on the final row.
- **Payload Inspector (`Send`):** Sticky right-hand `6px`-radius bordered `aside` divided by `1px` hairlines into four zones: header bar with `4px`-radius monospace locale tabs (`default`, `vi`, etc.), a `25%`-muted preview well cradling a `6px`-radius simulated notification card, a 5-row `<dl>` key-value dispatch summary (`Target`, `Source`, `Category`, `Persistence`, `Dispatch`), and an `11px` muted locale-resolution footnote.

## Do's and Don'ts

### Do:
- **Do** keep Cobalt Primary (`#2554d9` light / `#2f5ee5` dark) scarce—at most one primary action button per screen—while rendering secondary row, header, and dialog actions in `outline` or `ghost` variants.
- **Do** group related operational items (users, sessions, passkeys, OAuth links, trusted devices, templates) inside a single `6px`-radius `1px`-bordered `bg-card` ledger subdivided by `1px` hairlines.
- **Do** apply `font-variant-numeric: tabular-nums` and the monospace stack (`SF Mono`, `JetBrains Mono`) to all IDs, ASN/IP origin strings, timestamps, counters, and TOTP codes.
- **Do** reserve the `52px` border-notched `FloatingInput` (`4px` radius, `15px` text) for standalone Universal Login sheets and use compact `32px` (`28px` toolbar) `Input` controls (`6px` radius, `13px` text) inside the console.
- **Do** house theme switching (`System`, `Light`, `Dark`) inside the unified Account `DropdownMenu` radio group rather than persistent multi-button toggles in the header or sidebar.
- **Do** maintain full light/dark parity using stepped architectural luminance (`#f8f9fb` / `#ffffff` light; `#08090b` / `#0b0c0e` / `#111317` / `#15181e` dark) and `1px` hairlines.

### Don't:
- **Don't** place decorative glowing icon tiles above headings, invent brand logo marks, or add fake live-status indicator pills to the sidebar or page headers.
- **Don't** introduce purple, neon, or electric-blue gradients, glassmorphism blurs, or ambient drop shadows on in-flow tables, posture strips, or cards.
- **Don't** exceed the `8px` (`0.5rem`) corner-radius ceiling or render pill-shaped (`9999px`) buttons, inputs, or navigation items.
- **Don't** nest bordered cards inside other bordered cards; separate subsections with full-bleed `1px` hairlines and `35%` muted header bars instead.
- **Don't** set console headings, section titles, or table column headers in tracked-out `UPPERCASE` kickers or eyebrows.
- **Don't** load external webfont CDNs, remote icon scripts, or third-party assets that violate the Worker's self-contained `script-src 'self'` CSP.
