// Applies migrations to every D1 database in wrangler.jsonc, so an app's own databases migrate too.
// Usage: node scripts/migrate.mjs --local | --remote -c wrangler.production.jsonc
import { migrateAll } from "./prod-config.mjs";

const failed = await migrateAll(process.argv.slice(2));
if (failed) {
  process.stderr.write(failed.stderr ?? String(failed.error ?? ""));
  process.exit(failed.status ?? 1);
}
