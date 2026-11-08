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

## Next

- Admin and roles (Better Auth `admin` plugin), 2FA, organizations.
- Idempotency keys on `POST /v1/push`.
- Delivery and open analytics, notification templates, localized notifications.
- Web topic subscription (needs the legacy Instance ID API).
- Sharding `INBOX_DB` by user hash; archiving old inbox rows to R2.
