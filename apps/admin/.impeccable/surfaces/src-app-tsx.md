---
version: 1
slug: "src-app-tsx"
primary_target: "src/App.tsx"
related_targets: ["src/pages/SignIn.tsx","src/pages/AuthPortal.tsx","src/pages/TwoFactorSetup.tsx","src/pages/Users.tsx","src/pages/Send.tsx","src/pages/Pushes.tsx","src/pages/Templates.tsx","src/pages/Account.tsx"]
---

# EdgeBase Control Plane & Auth Portal

- **Scope:** Full `/admin/` control plane (`src/App.tsx` shell, `AuthPortal` covering `SignIn`, `SignUp`, `ForgotPassword`, `ResetPassword`, `VerifyEmail`, `TwoFactorSetup`, `PendingAccess`, plus console views `Users`, `Send`, `Pushes`, `Templates`, `Account`).
- **Mode:** Operate (code-led).
- **Audience & Task:** Platform engineers, backend developers, and application operators signing in (email/password, Passkey, OAuth), registering or verifying accounts, resetting forgotten passwords, enforcing 2FA, auditing D1 user accounts and ASN/geo session hops, managing WebAuthn passkeys and templates, and dispatching/tracking FCM push batches across light daytime and dark late-night incident windows.
- **Constraints:** Strict Worker CSP (`script-src 'self'`, zero external font CDNs or remote scripts), zero-SDK static bundle, strict TypeScript (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), user-selectable primary accent color (`#0369A1` Ocean Blue default / `#0EA5E9` dark, plus contrast-verified presets and custom color picker) paired with Light/Dark/System appearance, no eyebrow kickers above headings, no nested bordered cards, and no >1px colored side borders.
- **Signature Interaction:** Centered single-column Auth Portal with locked-geometry flow tabs (`Sign in`, `Create account`), step indicators (`#forgot-password`, `#reset-password`, `#two-factor`), live primary accent color & Light/Dark/System switcher in both Auth header and Console Account menu/Preferences, and inline `Origin -> Current` ASN hop connectors with inspection/payload drawers.
- **Unresolved Decisions:** None.

## Direction contract

THESIS: EdgeBase replaces the sterile generic Auth0 card and empty white/black dashboard boxes with a cohesive Technical Spec Sheet control plane inspired by Dieter Rams and Braun product catalogs—pairing centered authentication sheets with a tonally unified sidebar rail and workspace (all light in Light mode, all dark in Dark mode) and live customizable primary accent chroma defaulting to Ocean Blue.

OWN-WORLD: Unified light surface system (`#F3F2EE` paper workspace + `#FFFFFF` crisp specification rail and cards) or unified dark graphite system (`#111214` canvas + `#141518` rail + `#181A1D` cards), `1px` warm structural hairlines (`#DCDAD3` / `#2B2E35`), and user-selectable contrast-safe primary accent (`#0369A1` Ocean Blue default / `#0EA5E9` dark, plus Cobalt, Signal Vermilion, Emerald, Teal, Indigo, Amber, Monochrome, and Custom Hex) paired with strictly semantic Emerald, Amber, and Crimson telemetry tokens, crisp neo-grotesque typography, and tabular monospace figures.

STORY: Operators and users enter an uncluttered, centered authentication portal with unmistakable navigation across Sign In, Create Account, Email Verification, Forgot/Reset Password, and 2FA—then transition seamlessly into a high-density, tonally unified operational console where user directories, session ASN shifts, passkeys, localized templates, and FCM delivery batches read like precision engineering specifications.

FIRST VIEWPORT: Unauthenticated opens on a balanced single-column Auth Portal: slim top bar showing the geometric 2x2 BrandMark + app name on the left and the live Appearance + Accent Color popover on the right, framing a crisp centered `440px` specification card with `Sign in` / `Create account` mode tabs, standard crisp inputs, primary action in the user's chosen Ocean Blue accent, `Forgot password?` action, and Passkey & OAuth alternatives. Authenticated opens onto a sticky `248px` Tailscale-inspired left navigation rail matching the active color scheme (`Users`, collapsible `Push notifications` tree with `Send push` / `Sent pushes` / `Templates`, `Account & Security`, plus appearance/accent popover in the footer) beside a unified workspace displaying the `PageHeader`, compact 4-cell specification strip with tolerance bars, filterable tabular `Users` ledger, and quick action inspector.

FORM: Technical Spec Sheet (Dieter Rams / Braun technical catalog), position 3 of 7 grounded candidates, seed:29fcc5ea8b8482bf. Raised via four challenger disciplines: tight tabular monospace telemetry columns (Ikeda Datamatics), full-cell tonal selection without outer glow (Metro Typographic Tiles), locked-geometry step continuity across multi-step auth flows (Botanical Seasonal Folio), and bilateral vertical hairline alignment across paired panes (Labanotation Score).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
