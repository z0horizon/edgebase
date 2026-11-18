# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Platform engineers, backend developers, and application operators managing an EdgeBase deployment on Cloudflare Workers and D1. They open `/admin/` during live operations to inspect accounts, audit session/network security, enroll or rotate admin credentials, and dispatch or troubleshoot push notifications.

## Product Purpose

EdgeBase is a self-hosted backend foundation on Cloudflare Workers, D1, Queues, and FCM HTTP v1 for authentication, personal/broadcast inboxes, and transactional or marketing push delivery. The `/admin/` console is its zero-SDK operational control plane, served directly from Worker static assets under a strict same-origin CSP.

## Positioning

Every session and device revocation takes effect on the very next request against D1 with no KV or cookie-cache lag, paired with Cloudflare edge ASN/ISP/geo telemetry, WebAuthn FIDO2 passkeys, rotating 30-day 2FA device trust, and per-token push retry accounting on one Worker deployment.

## Operating Context

Used on desktop and laptop screens in both bright daytime offices and dark late-night incident or release windows (`prefers-color-scheme` with manual override). Operators scan user tables, verify ASN/IP origin shifts, manage passkeys and TOTP factors, compose localized template-driven FCM pushes, and verify delivery/open counts.

## Capabilities and Constraints

- Views: Sign-in (Passkey, OAuth providers, Email + Password + TOTP/Backup Code + 30-day device trust), Admin Second-Factor Onboarding (Passkey or TOTP QR + backup codes), Users (search, pagination, role grant, ban/unban, per-user active session telemetry & revocation, multi-user push selection), Send Push (broadcast/topic/selected users, category, inbox persistence, scheduling, template & variable preview, translations), Sent Pushes (delivery/failure/open metrics), Templates (CRUD up to 500 templates with `{{placeholder}}` highlighting), and Account & Security (passkeys, linked OAuth providers, active sessions, trusted devices).
- Technical constraints: React 19 + Tailwind CSS v4 + Vite static build into `apps/server/public/admin`, strict CSP (`script-src 'self'`, no external font CDNs), zero bloated UI dependencies.

## Brand Commitments

- Enterprise infrastructure & identity console craft bar aligned with Cloudflare Dashboard, WorkOS, and Stripe Dashboard: quiet chrome, high information density, crisp 1px hairlines, tabular numerals, semantic status colors only, and zero AI-generated decorative tropes (no glowing icon tiles above headings, no purple/electric-blue gradients, no nested card-in-card boxes).

## Evidence on Hand

- Live APIs in `packages/core` (`/api/auth/*`, `/v1/me`, `/v1/sessions`, `/v1/trusted-devices`, `/v1/admin/users/:userId/sessions`, `/v1/push`, `/v1/templates`).
- Admin console source in `apps/admin/src/`.

## Product Principles

- **Operational density over filler:** Tables, rows, and key-value ledgers lead; chrome recedes.
- **Immediate security legibility:** Authentication factors, ASN/ISP shifts, session freshness, and destructive actions state exact consequences without ambiguity.
- **Zero-dependency speed:** Instant page transitions, crisp native controls, and self-contained assets respecting the Worker's strict CSP.
