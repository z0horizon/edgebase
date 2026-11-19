// pnpm admin:create [--remote] [--yes] [--reset-2fa] [--keep-existing]: makes ADMIN_EMAIL an admin
// who can sign in with ADMIN_PASSWORD, with no mail or sign-up step. They set up TOTP at first
// sign-in; --reset-2fa makes them set it up again (a lost phone and lost backup codes). Both live in a gitignored file: .env.local for the
// local database, .env.production for the deployed one. An empty password is generated and saved.
// With EMAIL_PASSWORD=off (.env.production, or .dev.vars locally) there is no password: ADMIN_EMAIL
// signs in with a provider once, and this promotes that user.
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { hashPassword } from "better-auth/crypto";
import {
  ENV_FILE,
  ensureDevVars,
  PROD_CONFIG,
  readEnvFile,
  readTemplate,
  runWrangler,
  writeEnvFile,
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
    ? `UPDATE user SET role = 'admin', emailVerified = 1, banned = 0, passwordChangedAt = ${at}, updatedAt = ${at} WHERE id = ${sql(id)}`
    : `INSERT INTO user (id, name, email, emailVerified, role, passwordChangedAt, createdAt, updatedAt) VALUES (${sql(id)}, ${sql(email.split("@")[0])}, ${sql(email)}, 1, 'admin', ${at}, ${at}, ${at})`;
  const reset =
    resetTwoFactor && userId
      ? [
          `UPDATE user SET twoFactorEnabled = 0, twoFactorEnabledAt = NULL WHERE id = ${sql(id)}`,
          `DELETE FROM twoFactor WHERE userId = ${sql(id)}`,
          `DELETE FROM passkey WHERE userId = ${sql(id)}`,
        ]
      : [];
  const revoke = userId
    ? [
        `DELETE FROM session WHERE userId = ${sql(id)}`,
        `DELETE FROM trusted_device WHERE user_id = ${sql(id)}`,
        `DELETE FROM verification WHERE identifier GLOB 'trust-device-*' AND value = ${sql(id)}`,
      ]
    : [];
  return [
    user,
    ...reset,
    `DELETE FROM account WHERE userId = ${sql(id)} AND providerId = 'credential'`,
    `INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (${sql(ids.account)}, ${sql(id)}, 'credential', ${sql(id)}, ${sql(hash)}, ${at}, ${at})`,
    ...revoke,
  ];
}

/**
 * Whether the Worker runs with EMAIL_PASSWORD=off, worked out the way it gets the value: deployed,
 * `.env.production` or else the wrangler.jsonc var (renderConfig); locally, a key present in
 * .dev.vars (even empty) overrides the wrangler.jsonc var.
 */
export function passwordIsOff({ remote, env, devVars, templateVar }) {
  const value = remote
    ? env.EMAIL_PASSWORD || templateVar
    : "EMAIL_PASSWORD" in devVars
      ? devVars.EMAIL_PASSWORD
      : templateVar;
  return (value ?? "").trim().toLowerCase() === "off";
}

/** SQL for the user with `email`: id, role, and whether they can sign in without a password. */
export const findAdminCandidate = (email) =>
  `SELECT id, role, (EXISTS (SELECT 1 FROM account WHERE userId = user.id AND providerId <> 'credential')
     OR EXISTS (SELECT 1 FROM passkey WHERE userId = user.id)) AS passwordless
   FROM user WHERE email = ${sql(email)}`;

/**
 * What `pnpm admin:create` does with the user `found` (from findAdminCandidate, or undefined):
 * "keep" on a bootstrap rerun, "wait" until a passwordless user exists when EMAIL_PASSWORD=off,
 * "promote" that user, or "password" to create or reset a password admin.
 */
export function adminAction({ found, passwordOff, keepExisting }) {
  if (found && keepExisting) return "keep";
  if (!passwordOff) return "password";
  // An account that can only sign in with a password would be an admin nobody can reach: the
  // password routes are closed, and a provider may not join an existing admin by email.
  return found?.passwordless ? "promote" : "wait";
}

/**
 * SQL that makes the existing user `userId` an admin without touching their sign-in methods, for
 * EMAIL_PASSWORD=off: they signed in with a provider, whose session needs no TOTP. Sessions and
 * trusted devices from before are revoked, as on the password path, so admin rights start from a
 * fresh sign-in rather than a long-lived bearer token issued to a plain user.
 */
export function promoteStatements({ userId, now, resetTwoFactor = false }) {
  const at = sql(new Date(now).toISOString());
  const id = sql(userId);
  return [
    `UPDATE user SET role = 'admin', banned = 0, updatedAt = ${at} WHERE id = ${id}`,
    ...(resetTwoFactor
      ? [
          `UPDATE user SET twoFactorEnabled = 0, twoFactorEnabledAt = NULL WHERE id = ${id}`,
          `DELETE FROM twoFactor WHERE userId = ${id}`,
        ]
      : []),
    `DELETE FROM session WHERE userId = ${id}`,
    `DELETE FROM trusted_device WHERE user_id = ${id}`,
    `DELETE FROM verification WHERE identifier GLOB 'trust-device-*' AND value = ${id}`,
  ];
}

/**
 * Runs D1 statements from a 0600 temporary `.sql` file instead of `--command`, so secrets such as
 * the admin's password hash never appear in the OS process argument list.
 */
export function executeSql(statements, target, run = runWrangler) {
  const dir = mkdtempSync(join(tmpdir(), "edgebase-d1-"));
  const sqlFile = join(dir, "query.sql");
  try {
    writeFileSync(sqlFile, `${statements.join(";\n")};\n`, { mode: 0o600 });
    const result = run(["d1", "execute", "DB", ...target, "--json", "--file", sqlFile], {
      capture: true,
      env: { CI: "1" },
    });
    if (result.status !== 0) {
      throw new Error(`wrangler d1 execute failed:\n${result.stderr || result.stdout}`);
    }
    return JSON.parse(result.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  if (!remote && ensureDevVars()) console.log("✔ .dev.vars secrets filled in for local dev");
  const env = readEnvFile(file);
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
  const devVars =
    !remote && existsSync(".dev.vars") ? parseEnv(readFileSync(".dev.vars", "utf8")) : {};
  const passwordOff = passwordIsOff({
    remote,
    env,
    devVars,
    templateVar: (await readTemplate()).vars?.EMAIL_PASSWORD,
  });
  if (!passwordOff) {
    env.ADMIN_PASSWORD ||= randomBytes(18).toString("base64url");
    if (env.ADMIN_PASSWORD.length < 8) fail("ADMIN_PASSWORD must be at least 8 characters");
  }
  if (JSON.stringify(env) !== before) writeEnvFile(file, env);

  const target = remote ? ["--remote", "-c", PROD_CONFIG] : ["--local"];
  if (remote) await writeProdConfig(env);
  const d1 = (statements) => {
    try {
      return executeSql(statements, target);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  };

  const found = d1([findAdminCandidate(env.ADMIN_EMAIL)])[0]?.results[0];
  const rerun = `pnpm admin:create${remote ? " --remote" : ""}`;
  const action = adminAction({
    found,
    passwordOff,
    // Bootstrap reruns must not undo a password the admin has since changed.
    keepExisting: process.argv.includes("--keep-existing"),
  });
  if (action === "keep") {
    const hint =
      passwordOff && found.role !== "admin" ? `; run ${rerun} to make them an admin` : "";
    console.log(`✔ ${env.ADMIN_EMAIL} already exists; left unchanged${hint}`);
    return;
  }
  if (action === "wait") {
    console.log(
      `EMAIL_PASSWORD is off: sign in as ${env.ADMIN_EMAIL} with Google, Apple or GitHub once, then run ${rerun} to make that account an admin.`,
    );
    return;
  }
  if (action === "promote") {
    d1(
      promoteStatements({
        userId: found.id,
        now: Date.now(),
        resetTwoFactor: process.argv.includes("--reset-2fa"),
      }),
    );
    console.log(
      `✔ ${env.ADMIN_EMAIL} is an admin${remote ? "" : " (local)"}; they sign in again with their provider`,
    );
    return;
  }
  const statements = adminStatements({
    userId: found?.id ?? null,
    email: env.ADMIN_EMAIL,
    hash: await hashPassword(env.ADMIN_PASSWORD),
    now: Date.now(),
    resetTwoFactor: process.argv.includes("--reset-2fa"),
  });
  d1(statements);
  console.log(
    `✔ ${env.ADMIN_EMAIL} is an admin${remote ? "" : " (local)"}; the password is ADMIN_PASSWORD in apps/server/${file}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
