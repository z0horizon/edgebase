// Applies migrations to every D1 database in wrangler.jsonc, so an app's own databases migrate too.
// Usage: node scripts/migrate.mjs --local | --remote -c wrangler.production.jsonc
import { spawnSync } from "node:child_process";
import { readTemplate } from "./prod-config.mjs";

for (const { binding } of (await readTemplate()).d1_databases) {
  const args = ["d1", "migrations", "apply", binding, ...process.argv.slice(2)];
  const { status } = spawnSync("node_modules/.bin/wrangler", args, { stdio: "inherit" });
  if (status !== 0) process.exit(status ?? 1);
}
