// Turns .env.production (gitignored) and the committed wrangler.jsonc template into
// wrangler.production.jsonc, so no deploy-specific value ever lives in a committed file.
// Usage: node scripts/prod-config.mjs   (pnpm run deploy and db:migrate:remote call it first)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

export const ENV_FILE = ".env.production";
export const PROD_CONFIG = "wrangler.production.jsonc";

export const VAR_KEYS = [
  "BASE_URL",
  "TRUSTED_ORIGINS",
  "APP_SCHEME",
  "INBOX_TTL_DAYS",
  "MAIL_FROM",
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

export const parseEnvFile = (text) => parseEnv(text);

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
  for (const key of ["BETTER_AUTH_SECRET", "PUSH_API_KEY"])
    check(key, (v) => v !== "", "must be set");
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
  const queueName = { PUSH_QUEUE: `${name}-push`, PUSH_DLQ: `${name}-push-dlq` };
  const out = structuredClone(template);
  out.name = name;
  if (env.CLOUDFLARE_ACCOUNT_ID) out.account_id = env.CLOUDFLARE_ACCOUNT_ID;
  for (const [i, d] of out.d1_databases.entries()) {
    d.database_name = dbs[i].name;
    d.database_id = env[dbs[i].idKey];
  }
  for (const p of out.queues.producers) p.queue = queueName[p.binding];
  for (const c of out.queues.consumers) {
    c.queue = queueName.PUSH_QUEUE;
    c.dead_letter_queue = queueName.PUSH_DLQ;
  }
  out.vars = Object.fromEntries(VAR_KEYS.map((key) => [key, env[key]]));
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
    await writeProdConfig(parseEnvFile(readFileSync(ENV_FILE, "utf8")));
  } catch (error) {
    console.error(
      error.code === "ENOENT" ? `${ENV_FILE} not found: run pnpm bootstrap first` : error.message,
    );
    process.exit(1);
  }
}
