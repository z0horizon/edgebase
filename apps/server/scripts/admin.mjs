// pnpm admin:create [--remote] [--yes] [--reset-2fa] [--keep-existing]: makes ADMIN_EMAIL an admin
// who can sign in with ADMIN_PASSWORD, with no mail or sign-up step. They set up TOTP at first
// sign-in; --reset-2fa makes them set it up again (a lost phone and lost backup codes). Both live in a gitignored file: .env.local for the
// local database, .env.production for the deployed one. An empty password is generated and saved.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { hashPassword } from "better-auth/crypto";
import {
  ENV_FILE,
  PROD_CONFIG,
  parseEnvFile,
  serializeEnvFile,
  writeProdConfig,
} from "./prod-config.mjs";

export const LOCAL_FILE = ".env.local";
const EMAIL = /^[^@\s']+@[^@\s']+$/;

const sql = (value) => `'${String(value).replaceAll("'", "''")}'`;
const newId = () => randomBytes(24).toString("base64url").slice(0, 32);

/**
 * SQL that leaves exactly one credential account with `hash` for `email`, and the user an admin
 * with a verified email. `userId` is the existing user's id, or null to create one.
 * `resetTwoFactor` drops their TOTP secret and backup codes.
 */
export function adminStatements({
  userId,
  email,
  hash,
  now,
  resetTwoFactor = false,
  ids = { user: newId(), account: newId() },
}) {
  const at = sql(new Date(now).toISOString());
  const id = userId ?? ids.user;
  const user = userId
    ? `UPDATE user SET role = 'admin', emailVerified = 1, banned = 0, updatedAt = ${at} WHERE id = ${sql(id)}`
    : `INSERT INTO user (id, name, email, emailVerified, role, createdAt, updatedAt) VALUES (${sql(id)}, ${sql(email.split("@")[0])}, ${sql(email)}, 1, 'admin', ${at}, ${at})`;
  const reset =
    resetTwoFactor && userId
      ? [
          `UPDATE user SET twoFactorEnabled = 0 WHERE id = ${sql(id)}`,
          `DELETE FROM twoFactor WHERE userId = ${sql(id)}`,
        ]
      : [];
  return [
    user,
    ...reset,
    `DELETE FROM account WHERE userId = ${sql(id)} AND providerId = 'credential'`,
    `INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (${sql(ids.account)}, ${sql(id)}, 'credential', ${sql(id)}, ${sql(hash)}, ${at}, ${at})`,
  ];
}

async function main() {
  const remote = process.argv.includes("--remote");
  const yes = process.argv.includes("--yes");
  const file = remote ? ENV_FILE : LOCAL_FILE;
  const fail = (message) => {
    console.error(`✖ ${message}`);
    process.exit(1);
  };
  if (remote && !existsSync(file)) fail(`${file} not found: run pnpm bootstrap first`);
  const env = existsSync(file) ? parseEnvFile(readFileSync(file, "utf8")) : {};
  const before = JSON.stringify(env);

  if (!env.ADMIN_EMAIL) {
    if (yes) {
      console.log(`No ADMIN_EMAIL in ${file}: no admin created.`);
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    env.ADMIN_EMAIL = (await rl.question("Admin email: ")).trim();
    rl.close();
  }
  env.ADMIN_EMAIL = env.ADMIN_EMAIL.toLowerCase();
  if (!EMAIL.test(env.ADMIN_EMAIL)) fail(`ADMIN_EMAIL ${env.ADMIN_EMAIL} is not an email address`);
  env.ADMIN_PASSWORD ||= randomBytes(18).toString("base64url");
  if (env.ADMIN_PASSWORD.length < 8) fail("ADMIN_PASSWORD must be at least 8 characters");
  if (JSON.stringify(env) !== before) {
    writeFileSync(file, `# Never commit this file.\n${serializeEnvFile(env)}`, { mode: 0o600 });
    chmodSync(file, 0o600);
  }

  const target = remote ? ["--remote", "-c", PROD_CONFIG] : ["--local"];
  if (remote) await writeProdConfig(env);
  const d1 = (command) => {
    const result = spawnSync(
      "node_modules/.bin/wrangler",
      ["d1", "execute", "DB", ...target, "--json", "--command", command],
      { encoding: "utf8", env: { ...process.env, CI: "1" } },
    );
    if (result.status !== 0) fail(`wrangler d1 execute failed:\n${result.stderr || result.stdout}`);
    return JSON.parse(result.stdout);
  };

  const found = d1(`SELECT id FROM user WHERE email = ${sql(env.ADMIN_EMAIL)}`)[0]?.results[0];
  // Bootstrap reruns must not undo a password the admin has since changed.
  if (found && process.argv.includes("--keep-existing")) {
    console.log(`✔ ${env.ADMIN_EMAIL} already exists; left unchanged`);
    return;
  }
  const statements = adminStatements({
    userId: found?.id ?? null,
    email: env.ADMIN_EMAIL,
    hash: await hashPassword(env.ADMIN_PASSWORD),
    now: Date.now(),
    resetTwoFactor: process.argv.includes("--reset-2fa"),
  });
  d1(statements.join("; "));
  console.log(
    `✔ ${env.ADMIN_EMAIL} is an admin${remote ? "" : " (local)"}; the password is ADMIN_PASSWORD in apps/server/${file}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
