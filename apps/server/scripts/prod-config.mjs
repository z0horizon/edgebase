// Turns .env.production (gitignored) and the committed wrangler.jsonc template into
// wrangler.production.jsonc, so no deploy-specific value ever lives in a committed file.
// Usage: node scripts/prod-config.mjs   (pnpm run deploy and db:migrate:remote call it first)
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

export const ENV_FILE = ".env.production";
export const PROD_CONFIG = "wrangler.production.jsonc";

export const VAR_KEYS = [
  "APP_NAME",
  "BASE_URL",
  "TRUSTED_ORIGINS",
  "APP_SCHEME",
  "INBOX_TTL_DAYS",
  "MAIL_FROM",
  "EMAIL_PASSWORD",
  "SESSION_ACTIVITY",
];
export const SECRET_KEYS = [
  "BETTER_AUTH_SECRET",
  "PUSH_API_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "APPLE_CLIENT_ID",
  "APPLE_CLIENT_SECRET",
  "APPLE_APP_BUNDLE_IDENTIFIER",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "TURNSTILE_SECRET_KEY",
];

/** Generated, never typed: bootstrap and ensureDevVars fill them, validate requires them. */
export const GENERATED_SECRETS = ["BETTER_AUTH_SECRET", "PUSH_API_KEY"];

/**
 * `file` with every key of `<file>.example` first, in the example's order (parseEnv sorts them),
 * so a rewrite reads the same on every machine. Missing keys are "".
 */
export function readEnvFile(file) {
  const example = existsSync(`${file}.example`) ? readFileSync(`${file}.example`, "utf8") : "";
  const keys = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
  return {
    ...Object.fromEntries(keys.map((k) => [k, ""])),
    ...(existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {}),
  };
}

/** Writes an env file only its owner can read. */
export function writeEnvFile(file, env) {
  const about = env.PROJECT_NAME ? `Deploy values and secrets for ${env.PROJECT_NAME}. ` : "";
  const explained = existsSync(`${file}.example`)
    ? `# Every key is explained in ${file}.example.\n`
    : "";
  writeFileSync(file, `# ${about}Never commit this file.\n${explained}${serializeEnvFile(env)}`, {
    mode: 0o600,
  });
  chmodSync(file, 0o600);
}

/** Runs the project's wrangler. `capture` returns stdout instead of showing it; stderr is returned. */
export function runWrangler(args, { capture = false, input, env = {} } = {}) {
  return spawnSync("node_modules/.bin/wrangler", args, {
    input,
    encoding: "utf8",
    stdio: [input === undefined ? "inherit" : "pipe", capture ? "pipe" : "inherit", "pipe"],
    env: { ...process.env, ...env },
  });
}

/**
 * Applies migrations to every D1 database in wrangler.jsonc, so an app's own databases migrate
 * too. Returns the first failed wrangler result, or null.
 */
export async function migrateAll(args, run = runWrangler) {
  for (const { binding } of (await readTemplate()).d1_databases) {
    const result = run(["d1", "migrations", "apply", binding, ...args]);
    if (result.status !== 0) return result;
  }
  return null;
}

/** The queues of a project: `<name>-push` and its dead letter queue. */
export const queueNames = (projectName) => ({
  PUSH_QUEUE: `${projectName}-push`,
  PUSH_DLQ: `${projectName}-push-dlq`,
});

/**
 * parseEnv keeps single-quoted and backtick-quoted values verbatim but has no escapes, so each
 * value gets a quote character it does not contain.
 */
export function serializeEnvFile(env) {
  return Object.entries(env)
    .map(([key, value]) => {
      if (/[\r\n]/.test(value)) throw new Error(`${key} must not contain a newline`);
      const quote = ["'", "`", '"'].find((q) => !value.includes(q));
      if (!quote)
        throw new Error(`${key} contains all of ' \` and ", which a .env file cannot hold`);
      return `${key}=${quote}${value}${quote}\n`;
    })
    .join("");
}

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const LOCAL_ORIGIN = /\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|,|$)/;

/** Problems with a production env, one message per bad key; empty when it is ready to deploy. */
export function validate(env) {
  const problems = [];
  const check = (key, ok, message) => {
    if (!ok(env[key] ?? "")) problems.push(`${key} ${message}`);
  };
  check(
    "PROJECT_NAME",
    (v) => /^[a-z][a-z0-9-]{0,40}$/.test(v),
    "must be lowercase letters, digits and dashes, starting with a letter",
  );
  check(
    "BASE_URL",
    (v) => URL.canParse(v) && new URL(v).protocol === "https:",
    "must be an https:// URL",
  );
  check("APP_SCHEME", (v) => /^[a-z][a-z0-9+.-]*$/.test(v), "must be a URL scheme such as myapp");
  check(
    "TRUSTED_ORIGINS",
    (v) => v.trim() !== "" && !LOCAL_ORIGIN.test(v),
    "must be set and must not trust localhost in production",
  );
  check("MAIL_FROM", (v) => /^[^@\s]+@[^@\s]+$/.test(v), "must be an email address");
  check("INBOX_TTL_DAYS", (v) => /^[1-9]\d*$/.test(v), "must be a whole number of days");
  check(
    "APP_NAME",
    (v) => /^[^\p{Cc}<>]{0,40}$/u.test(v),
    "must be at most 40 characters, without < > or control characters",
  );
  check("EMAIL_PASSWORD", (v) => /^(on|off)?$/.test(v), "must be on, off or empty (on)");
  check("SESSION_ACTIVITY", (v) => /^(on|off)?$/.test(v), "must be on, off or empty (on)");
  // Without Turnstile, sign-up and password reset let anyone send mail to any address at the
  // sender's cost; the per-IP and per-email limits slow one machine or one address, not a botnet.
  if ((env.EMAIL_PASSWORD ?? "") !== "off") {
    check(
      "TURNSTILE_SECRET_KEY",
      (v) => v !== "",
      "must be set while email and password sign-in is on (Cloudflare dashboard > Turnstile, free), or set EMAIL_PASSWORD=off",
    );
  }
  const domain = env.CUSTOM_DOMAIN ?? "";
  const domainOk = HOSTNAME.test(domain) && !domain.endsWith(".workers.dev");
  check(
    "CUSTOM_DOMAIN",
    (v) => v === "" || domainOk,
    "must be a hostname on a zone in your Cloudflare account, such as api.example.com, or empty",
  );
  // The custom domain becomes the only public address, so BASE_URL has to be that address.
  if (domainOk && URL.canParse(env.BASE_URL ?? "")) {
    check(
      "BASE_URL",
      (v) => new URL(v).hostname === env.CUSTOM_DOMAIN,
      `must be https://${env.CUSTOM_DOMAIN} when CUSTOM_DOMAIN is set`,
    );
  }
  for (const key of GENERATED_SECRETS) check(key, (v) => v !== "", "must be set");
  return problems;
}

/**
 * Every D1 database in the template, named for the project: `edgebase-inbox` becomes
 * `<PROJECT_NAME>-inbox`, and its id lives in `.env.production` as `<binding>_ID`. Adding a
 * database to wrangler.jsonc is all bootstrap, deploy and migrations need.
 */
export function databases(template, projectName) {
  const prefix = `${template.name}-`;
  return template.d1_databases.map((d) => {
    if (!d.database_name.startsWith(prefix)) {
      throw new Error(`wrangler.jsonc: database_name ${d.database_name} must start with ${prefix}`);
    }
    return {
      binding: d.binding,
      name: `${projectName}-${d.database_name.slice(prefix.length)}`,
      idKey: `${d.binding}_ID`,
    };
  });
}

/** The deployable config: the template with names, database ids and vars from the env. */
export function renderConfig(template, env) {
  const name = env.PROJECT_NAME;
  const dbs = databases(template, name);
  const unset = dbs.filter((d) => !env[d.idKey]).map((d) => d.idKey);
  if (unset.length > 0) {
    throw new Error(`${ENV_FILE} has no ${unset.join(", ")}: run pnpm bootstrap first`);
  }
  const queueName = queueNames(name);
  const out = structuredClone(template);
  out.name = name;
  if (env.CLOUDFLARE_ACCOUNT_ID) out.account_id = env.CLOUDFLARE_ACCOUNT_ID;
  // With a custom domain the zone's WAF and rate limiting rules guard every request, so the
  // addresses that bypass the zone (workers.dev, preview URLs) are closed.
  if (env.CUSTOM_DOMAIN) {
    out.routes = [{ pattern: env.CUSTOM_DOMAIN, custom_domain: true }];
    out.workers_dev = false;
    out.preview_urls = false;
  }
  for (const [i, d] of out.d1_databases.entries()) {
    d.database_name = dbs[i].name;
    d.database_id = env[dbs[i].idKey];
  }
  for (const p of out.queues.producers) p.queue = queueName[p.binding];
  for (const c of out.queues.consumers) {
    c.queue = queueName.PUSH_QUEUE;
    c.dead_letter_queue = queueName.PUSH_DLQ;
  }
  for (const m of out.send_email ?? []) {
    if (m.name === "MAIL") m.allowed_sender_addresses = [env.MAIL_FROM];
  }
  // An optional var left empty (APP_NAME, EMAIL_PASSWORD, SESSION_ACTIVITY) keeps the template's default; required ones are validated.
  out.vars = Object.fromEntries(VAR_KEYS.map((key) => [key, env[key] || template.vars[key]]));
  return out;
}

/** Every secret for `wrangler secret bulk`; null deletes one that is no longer set. */
export function secretsPayload(env, readFile = (path) => readFileSync(path, "utf8")) {
  const payload = Object.fromEntries(SECRET_KEYS.map((key) => [key, env[key] || null]));
  payload.FCM_SERVICE_ACCOUNT = null;
  if (env.FCM_SERVICE_ACCOUNT_FILE) {
    const sa = JSON.parse(readFile(env.FCM_SERVICE_ACCOUNT_FILE));
    for (const field of ["project_id", "client_email", "private_key"]) {
      if (!sa[field]) throw new Error(`${env.FCM_SERVICE_ACCOUNT_FILE} has no ${field}`);
    }
    payload.FCM_SERVICE_ACCOUNT = JSON.stringify(sa);
  }
  return payload;
}

/**
 * Local secrets: creates .dev.vars from its example and fills an empty BETTER_AUTH_SECRET or
 * PUSH_API_KEY, never replacing a value, since TOTP secrets and sessions depend on the first.
 * Returns whether it changed the file.
 */
export function ensureDevVars(secret = () => randomBytes(32).toString("base64")) {
  const before = existsSync(".dev.vars") ? readFileSync(".dev.vars", "utf8") : null;
  let text = before ?? readFileSync(".dev.vars.example", "utf8");
  for (const key of GENERATED_SECRETS) {
    text = text.replace(new RegExp(`^${key}=$`, "m"), `${key}=${secret()}`);
  }
  if (text === before) return false;
  writeFileSync(".dev.vars", text, { mode: 0o600 });
  return true;
}

export function readTemplate() {
  return import("wrangler").then(
    (w) => w.experimental_readRawConfig({ config: "wrangler.jsonc" }).rawConfig,
  );
}

export async function writeProdConfig(env) {
  const problems = validate(env);
  if (problems.length > 0) throw new Error(`${ENV_FILE}:\n- ${problems.join("\n- ")}`);
  const config = renderConfig(await readTemplate(), env);
  writeFileSync(
    PROD_CONFIG,
    `// Generated by scripts/prod-config.mjs; edit ${ENV_FILE} instead.\n${JSON.stringify(config, null, 2)}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await writeProdConfig(parseEnv(readFileSync(ENV_FILE, "utf8")));
  } catch (error) {
    console.error(
      error.code === "ENOENT" ? `${ENV_FILE} not found: run pnpm bootstrap first` : error.message,
    );
    process.exit(1);
  }
}
