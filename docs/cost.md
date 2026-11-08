# Cost

Prices are Cloudflare's list prices when this was written; check the current pricing pages
before relying on the numbers.

## Included in Workers Paid ($5 / month)

| Service | Included | Beyond |
|---|---|---|
| Workers requests | 10M / month | $0.30 / M |
| Workers CPU | 30M ms / month | $0.02 / M ms |
| D1 rows read | 25B / month | $0.001 / M |
| D1 rows written | 50M / month | $1.00 / M |
| D1 storage | 5 GB | $0.75 / GB-month; 10 GB max per database |
| Queues | 1M operations / month | $0.40 / M (a message is about 3 operations) |

FCM is free. Email Sending is billed separately.

## Write rules built into the code

- Every row written costs one extra write per index it touches; deletes count as writes.
- `inbox_item` uses an integer rowid key (2 writes per insert); a TEXT key would add an
  automatic index (3 writes).
- Device upserts write only on change or after 7 days; sessions write at most once a day.
- Broadcasts write one row, never one per user; "read all" is one write.

## 1M users, one inbox item per user per day, 30-day TTL

- **Storage:** ~30M `inbox_item` rows × ~400 B ≈ **12 GB**, over the 10 GB limit of `INBOX_DB`.
- **Writes:** ~30M inserts × 2 + ~30M deletes × 2 ≈ 120M row writes / month ≈ **$70** beyond
  the included 50M.
- **Queues:** 30M users / 50 per message ≈ 600k messages ≈ 1.8M operations ≈ under $1.

Mitigations, in order:

1. Send with `inbox: true` only when the push should be kept; many pushes do not need history.
2. Lower `INBOX_TTL_DAYS` to 14–21.
3. Shard `INBOX_DB` by a hash of `user_id` (roadmap).
