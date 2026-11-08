# Roadmap

## Done

- Better Auth sign-in: email + password with verification and reset, Google, Apple, GitHub;
  bearer tokens for mobile; one-time-token handoff for native browser OAuth; immediate revocation.
- Auth rate limiting per IP, fail-closed configuration checks, account deletion with inbox cleanup.
- FCM device registration with write-skipping upsert and a 10-device cap.
- Push send API (users, topics, marketing opt-in), queue delivery with per-token retry and DLQ.
- Scheduled pushes (minute precision).
- Inbox with broadcasts, cursor paging, read state.
- Daily retention cleanup with size logging.
- Admin and roles (Better Auth `admin`), TOTP 2FA with backup codes, organizations.
- Idempotency keys on `POST /v1/push`.
- Push stats (users, sent, failed, unique opens), templates, localized notifications.
- Web topic subscription through the Instance ID API.
- Admin web page at `/admin` (users, roles, bans, sending pushes, templates, push stats).

## Next

- Audit log of admin actions and pushes sent.
- Sharding `INBOX_DB` by user hash; archiving old inbox rows to R2.
