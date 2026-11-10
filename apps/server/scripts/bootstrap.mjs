// pnpm bootstrap [--yes]: prepares a Cloudflare deployment from .env.production (gitignored).
// Safe to rerun: every step checks what already exists and saves its result before moving on.
// It stops before deploying; run `pnpm run deploy` after it.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import {
  databases,
  ENV_FILE,
  ensureDevVars,
  GENERATED_SECRETS,
  migrateAll,
  PROD_CONFIG,
  queueNames,
  readEnvFile,
  readTemplate,
  runWrangler,
  secretsPayload,
  validate,
  writeEnvFile,
  writeProdConfig,
} from "./prod-config.mjs";

// Before the workspace layout these files sat at the repository root; starting over here would
// generate new secrets and sign every user out.
for (const old of [ENV_FILE, ".dev.vars"]) {
  if (existsSync(`../../${old}`)) {
    console.error(
      `✖ ${old} is at the repository root: move it to apps/server/, then run this again.`,
    );
    process.exit(1);
  }
}

const yes = process.argv.includes("--yes");
const rl = yes ? null : createInterface({ input: process.stdin, output: process.stdout });
const randomSecret = () => randomBytes(32).toString("base64");

function fail(message) {
  console.error(`\n✖ ${message}`);
  rl?.close();
  process.exit(1);
}

/** Runs wrangler; stops setup on failure. `capture` returns stdout instead of showing it. */
function wrangler(args, { capture = false, input, allowFail = false } = {}) {
  const result = runWrangler(args, {
    capture,
    input,
    // --yes must never wait on a wrangler confirmation prompt.
    env: {
      ...(env.CLOUDFLARE_ACCOUNT_ID && { CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID }),
      ...(yes && { CI: "1" }),
    },
  });
  if (result.status !== 0 && !allowFail) {
    fail(`wrangler ${args.join(" ")} failed:\n${result.stderr || result.stdout || result.error}`);
  }
  return result;
}

async function ask(question, fallback = "") {
  const answer = (await rl.question(`${question}${fallback ? ` [${fallback}]` : ""}: `)).trim();
  return answer || fallback;
}

const env = readEnvFile(ENV_FILE);
const save = () => writeEnvFile(ENV_FILE, env);

// 1. Cloudflare login and account.
const who = wrangler(["whoami", "--json"], { capture: true, allowFail: true });
const account = who.status === 0 ? JSON.parse(who.stdout) : null;
if (!account?.loggedIn)
  fail("Not logged in to Cloudflare: run `npx wrangler login`, then `pnpm bootstrap` again.");
const accounts = account.accounts ?? [];
if (env.CLOUDFLARE_ACCOUNT_ID && !accounts.some((a) => a.id === env.CLOUDFLARE_ACCOUNT_ID)) {
  fail(`CLOUDFLARE_ACCOUNT_ID in ${ENV_FILE} is not an account this login can use.`);
}
if (!env.CLOUDFLARE_ACCOUNT_ID && accounts.length > 1) {
  if (yes)
    fail(`This login has ${accounts.length} accounts: set CLOUDFLARE_ACCOUNT_ID in ${ENV_FILE}.`);
  for (const [i, a] of accounts.entries()) console.log(`  ${i + 1}. ${a.name}`);
  const pick = accounts[Number(await ask("Which Cloudflare account", "1")) - 1];
  if (!pick) fail("No such account.");
  env.CLOUDFLARE_ACCOUNT_ID = pick.id;
}

// 2. Deploy values. Secrets are generated, never typed, so they do not land in shell history.
const defaults = {
  PROJECT_NAME: () => "edgebase",
  APP_SCHEME: () => env.PROJECT_NAME,
  TRUSTED_ORIGINS: () => `${env.APP_SCHEME}://,https://appleid.apple.com`,
  INBOX_TTL_DAYS: () => "30",
};
for (const key of GENERATED_SECRETS) env[key] ||= randomSecret();
const missing = [];
for (const key of [
  "PROJECT_NAME",
  "BASE_URL",
  "APP_SCHEME",
  "TRUSTED_ORIGINS",
  "MAIL_FROM",
  "INBOX_TTL_DAYS",
]) {
  const problemsOf = () => validate(env).filter((p) => p.startsWith(`${key} `));
  if (yes) {
    env[key] ||= defaults[key]?.() ?? "";
    missing.push(...problemsOf());
    continue;
  }
  while (problemsOf().length > 0) {
    if (env[key]) console.log(`  ${problemsOf()[0]}`);
    env[key] = await ask(key, env[key] || defaults[key]?.());
  }
}
if (missing.length > 0) fail(`Fix ${ENV_FILE}:\n- ${missing.join("\n- ")}`);
rl?.close();
save();
console.log(`✔ ${ENV_FILE} saved (mode 600)`);

// 3. Databases: reuse by name, create when missing.
const d1List = () => JSON.parse(wrangler(["d1", "list", "--json"], { capture: true }).stdout);
const dbs = databases(await readTemplate(), env.PROJECT_NAME);
for (const { idKey: key, name } of dbs) {
  let found = d1List().find((d) => d.name === name);
  if (!found) {
    wrangler(["d1", "create", name], { capture: true });
    found = d1List().find((d) => d.name === name);
    if (!found) fail(`Created D1 database ${name} but cannot find it in wrangler d1 list.`);
  }
  env[key] = found.uuid;
  save();
  console.log(`✔ D1 ${name}`);
}

// 4. Queues. `queues list` has no JSON output, so names come from its table.
const existingQueues = new Set();
for (let page = 1; page <= 50; page++) {
  const table = wrangler(["queues", "list", "--page", String(page)], { capture: true }).stdout;
  const names = [...table.matchAll(/│\s*[0-9a-f]{32}\s*│\s*(\S+)\s*│/g)].map((m) => m[1]);
  if (names.length === 0) break;
  for (const n of names) existingQueues.add(n);
}
for (const name of Object.values(queueNames(env.PROJECT_NAME))) {
  if (!existingQueues.has(name)) wrangler(["queues", "create", name], { capture: true });
  console.log(`✔ Queue ${name}`);
}

// 5. Config and migrations.
try {
  await writeProdConfig(env);
} catch (error) {
  fail(error.message);
}
console.log(`✔ ${PROD_CONFIG} written`);
await migrateAll(["--remote", "-c", PROD_CONFIG], wrangler);

// 6. Secrets, on stdin so they never touch a temporary file. Creates a draft Worker if needed.
let payload;
try {
  payload = secretsPayload(env);
} catch (error) {
  fail(`FCM_SERVICE_ACCOUNT_FILE: ${error.message}`);
}
wrangler(["secret", "bulk", "-c", PROD_CONFIG], { input: JSON.stringify(payload) });
const off = Object.keys(payload).filter((k) => payload[k] === null);
console.log(
  `✔ Secrets uploaded${off.length > 0 ? `; not set (feature off): ${off.join(", ")}` : ""}`,
);

// 7. The first admin, from ADMIN_EMAIL and ADMIN_PASSWORD.
const admin = spawnSync(
  "node",
  ["scripts/admin.mjs", "--remote", "--keep-existing", ...(yes ? ["--yes"] : [])],
  {
    stdio: "inherit",
  },
);
if (admin.status !== 0)
  fail("Creating the admin failed; fix it and run pnpm admin:create --remote.");

// 8. Local dev secrets, separate from production.
if (ensureDevVars()) console.log("✔ .dev.vars secrets filled in for local dev");

console.log(
  `\nReady. Next: pnpm run deploy\nOptional sign-in providers and push: fill them in ${ENV_FILE}, then pnpm bootstrap again.`,
);
