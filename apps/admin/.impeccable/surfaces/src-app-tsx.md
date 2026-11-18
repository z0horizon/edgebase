---
version: 1
slug: "src-app-tsx"
primary_target: "src/App.tsx"
related_targets: ["src/pages/SignIn.tsx","src/pages/TwoFactorSetup.tsx","src/pages/Users.tsx","src/pages/Send.tsx","src/pages/Pushes.tsx","src/pages/Templates.tsx","src/pages/Account.tsx"]
---

# EdgeBase Admin Console

- **Scope:** Full `/admin/` control plane (`src/App.tsx` shell, `SignIn`, `TwoFactorSetup`, `Users`, `Send`, `Pushes`, `Templates`, `Account`).
- **Mode:** Operate (code-led).
- **Audience & Task:** Platform engineers and application operators authenticating via logo-free Auth0-grade Universal Login, auditing accounts, revoking sessions/trusted devices, enrolling WebAuthn passkeys or TOTP, managing templates, and dispatching/monitoring FCM push batches in daytime light and night-ops dark scenes.
- **Constraints:** Strict Worker CSP (`script-src 'self'`, no external font CDNs), zero-SDK static bundle, strict TypeScript, no AI-slop decorative tropes, no brand logo mark, no fake header status indicators (`D1 live`), no 3-icon segmented theme box, and no boxed monogram footer.
- **Signature Interaction:** Auth0 Universal Login border-notched floating labels on `SignIn` / `TwoFactorSetup`, unified sidebar Account popover menu (`Account & Security`, `Appearance` radio group, `Log out`), and live OS-neutral notification + payload ledger preview in `Send`.
- **Unresolved Decisions:** None.

## Direction contract

THESIS: EdgeBase Admin pairs a logo-free Auth0 Universal Login authentication sheet with a precision infrastructure ledger in the lineage of Cloudflare, WorkOS, and Stripe—refusing AI-era glowing icon tiles, invented logos, fake status dots, 3-button theme pills, boxed monograms, and nested card clutter in favor of calm authentication sheets and continuous 1px hairline operational tables.

OWN-WORLD: Restrained carbon-zinc architectural neutrals (`#f8f9fb` canvas, `#ffffff` card/ledger, `#f1f3f6` rail, `#e2e5eb` 1px borders in light; `#0b0c0e` canvas, `#111317` card/ledger, `#08090b` rail, `#22262f` borders in dark) with disciplined cobalt-indigo primary action (`#2554d9` / `#2f5ee5`), 4px–6px sharp geometry, semantic status chips, and tabular numerals throughout.

STORY: Operators enter through an authoritative, clutter-free Universal Login card and land directly in a zero-chrome D1 control plane where every session ASN shift, passkey factor, template token, and push delivery count is scannable at a glance.

FIRST VIEWPORT: Unauthenticated opens onto a calm light/dark architectural canvas with a centered 400px Auth0-style Universal Login card (`px-10 py-10`), no logo mark, centered "Welcome" heading, 52px border-notched floating-label credential inputs, full-width primary "Continue" button, "OR" hairline divider, and left-aligned passkey/OAuth buttons below. Authenticated opens onto a 224px typographic left rail (with a clean email + chevron Account popover menu at the bottom) and a full-width 1px-bordered Users ledger with no redundant top status bar.

FORM: Standing exit / enterprise infrastructure & Auth0 Universal Login canon (Auth0 / Cloudflare / WorkOS / Stripe craft bar), position 1 (canon choice + user-pinned refinements), seed:4482a524e51f91c0.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
