import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseEnv } from "node:util";
import { CRONS } from "@edgebase/core/crons";
import { experimental_readRawConfig } from "wrangler";
import {
  ensureDevVars,
  readEnvFile,
  renderConfig,
  secretsPayload,
  serializeEnvFile,
  validate,
  writeEnvFile,
} from "./prod-config.mjs";

const template = experimental_readRawConfig({ config: "wrangler.jsonc" }).rawConfig;

const valid = {
  PROJECT_NAME: "myapp",
  BASE_URL: "https://api.myapp.example",
  APP_SCHEME: "myapp",
  TRUSTED_ORIGINS: "myapp://,https://appleid.apple.com",
  MAIL_FROM: "no-reply@myapp.example",
  INBOX_TTL_DAYS: "30",
  DB_ID: "11111111-1111-1111-1111-111111111111",
  INBOX_DB_ID: "22222222-2222-2222-2222-222222222222",
  BETTER_AUTH_SECRET: "auth-secret",
  PUSH_API_KEY: "push-key",
  TURNSTILE_SECRET_KEY: "turnstile-secret",
};

describe("renderConfig", () => {
  const out = renderConfig(template, valid);

  it("renames the worker, both databases and both queues after PROJECT_NAME", () => {
    assert.equal(out.name, "myapp");
    assert.deepEqual(
      out.d1_databases.map((d) => [d.binding, d.database_name, d.database_id]),
      [
        ["DB", "myapp-db", valid.DB_ID],
        ["INBOX_DB", "myapp-inbox", valid.INBOX_DB_ID],
      ],
    );
    assert.deepEqual(
      out.queues.producers.map((p) => [p.binding, p.queue]),
      [
        ["PUSH_QUEUE", "myapp-push"],
        ["PUSH_DLQ", "myapp-push-dlq"],
      ],
    );
    assert.equal(out.queues.consumers[0].queue, "myapp-push");
    assert.equal(out.queues.consumers[0].dead_letter_queue, "myapp-push-dlq");
  });

  it("takes vars from the env, locks send_email to MAIL_FROM, and keeps everything else from the template", () => {
    assert.deepEqual(out.vars, {
      APP_NAME: "EdgeBase",
      BASE_URL: valid.BASE_URL,
      TRUSTED_ORIGINS: valid.TRUSTED_ORIGINS,
      APP_SCHEME: valid.APP_SCHEME,
      INBOX_TTL_DAYS: valid.INBOX_TTL_DAYS,
      MAIL_FROM: valid.MAIL_FROM,
      EMAIL_PASSWORD: "on",
      EMAIL_SENDING: "on",
      SESSION_ACTIVITY: "on",
      SESSION_REFRESH_DAYS: "3",
    });
    assert.deepEqual(out.send_email, [
      { name: "MAIL", allowed_sender_addresses: [valid.MAIL_FROM] },
    ]);
    assert.equal(template.upload_source_maps, true);
    assert.equal(
      renderConfig(template, { ...valid, EMAIL_PASSWORD: "off" }).vars.EMAIL_PASSWORD,
      "off",
    );
    assert.equal(renderConfig(template, { ...valid, APP_NAME: "My App" }).vars.APP_NAME, "My App");
  });

  it("serves only on CUSTOM_DOMAIN when set, and leaves workers.dev alone otherwise", () => {
    for (const key of ["routes", "workers_dev", "preview_urls"]) assert.equal(key in out, false);
    const custom = renderConfig(template, { ...valid, CUSTOM_DOMAIN: "api.myapp.example" });
    assert.deepEqual(custom.routes, [{ pattern: "api.myapp.example", custom_domain: true }]);
    assert.equal(custom.workers_dev, false);
    assert.equal(custom.preview_urls, false);
  });

  it("keeps everything else from the template", () => {
    for (const key of [
      "triggers",
      "ratelimits",
      "compatibility_date",
      "upload_source_maps",
      "main",
    ]) {
      assert.deepEqual(out[key], template[key], key);
    }
    assert.equal(
      out.queues.consumers[0].max_batch_size,
      template.queues.consumers[0].max_batch_size,
    );
  });

  it("pins the Cloudflare account when one is chosen, so deploy never asks", () => {
    const pinned = renderConfig(template, { ...valid, CLOUDFLARE_ACCOUNT_ID: "acc123" });
    assert.equal(pinned.account_id, "acc123");
    assert.equal("account_id" in out, false);
  });

  it("leaves the template object untouched", () => {
    assert.equal(template.name, "edgebase");
    assert.equal(template.d1_databases[0].database_id, "local");
  });

  it("refuses to render before setup has stored the database ids", () => {
    assert.throws(
      () => renderConfig(template, { ...valid, DB_ID: "" }),
      /no DB_ID: run pnpm bootstrap first/,
    );
  });

  it("names and fills a database the app adds, from its <binding>_ID", () => {
    const extra = { binding: "APP_DB", database_name: "edgebase-app", database_id: "local-app" };
    const withApp = { ...template, d1_databases: [...template.d1_databases, extra] };
    const appId = "33333333-3333-3333-3333-333333333333";
    const rendered = renderConfig(withApp, { ...valid, APP_DB_ID: appId });
    assert.deepEqual(rendered.d1_databases.at(-1), {
      ...extra,
      database_name: "myapp-app",
      database_id: appId,
    });
    assert.throws(() => renderConfig(withApp, valid), /no APP_DB_ID/);
  });

  it("refuses a database whose name does not start with the template's name", () => {
    const odd = { ...template, d1_databases: [{ binding: "X", database_name: "other" }] };
    assert.throws(() => renderConfig(odd, valid), /must start with edgebase-/);
  });
});

describe("env file", () => {
  it("reads back exactly what it wrote, whatever quotes a value holds", () => {
    const env = {
      PLAIN: "abc",
      EMPTY: "",
      BASE64: "a+b/c==",
      HASH_EQ: "a=b #c",
      SINGLE: "it's",
      BOTH: `it's "x"`,
      BACKSLASH_N: String.raw`a\nb`,
    };
    assert.deepEqual(parseEnv(serializeEnvFile(env)), env);
  });

  it("rejects a value with a newline", () => {
    assert.throws(() => serializeEnvFile({ K: "a\nb" }), /K/);
  });
});

describe("validate", () => {
  it("accepts a complete production env", () => {
    assert.deepEqual(validate(valid), []);
    assert.deepEqual(validate({ ...valid, EMAIL_PASSWORD: "off", APP_NAME: "My App" }), []);
  });

  it("requires Turnstile while email and password sign-in is on", () => {
    const { TURNSTILE_SECRET_KEY: _, ...bare } = valid;
    for (const mode of [undefined, "", "on"]) {
      const problems = validate({ ...bare, EMAIL_PASSWORD: mode });
      assert.equal(problems.length, 1, problems.join("; "));
      assert.match(problems[0], /^TURNSTILE_SECRET_KEY must be set .* or set EMAIL_PASSWORD=off$/);
    }
    assert.deepEqual(validate({ ...bare, EMAIL_PASSWORD: "off" }), []);
  });

  it("EMAIL_SENDING=off needs no MAIL_FROM but needs passwords off, and drops the mail binding", () => {
    const off = { ...valid, EMAIL_SENDING: "off", EMAIL_PASSWORD: "off", MAIL_FROM: "" };
    assert.deepEqual(validate(off), []);
    const problems = validate({ ...off, EMAIL_PASSWORD: "on" });
    assert.equal(problems.length, 1, problems.join("; "));
    assert.match(problems[0], /^EMAIL_SENDING off needs EMAIL_PASSWORD=off/);
    const rendered = renderConfig(template, off);
    assert.equal("send_email" in rendered, false);
    assert.equal(rendered.vars.EMAIL_SENDING, "off");
    assert.equal(rendered.vars.MAIL_FROM, template.vars.MAIL_FROM);
  });

  it("requires BASE_URL to be the custom domain", () => {
    const env = { ...valid, CUSTOM_DOMAIN: "api.myapp.example" };
    assert.deepEqual(validate(env), []);
    const problems = validate({ ...env, BASE_URL: "https://myapp.me.workers.dev" });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /^BASE_URL must be https:\/\/api\.myapp\.example/);
  });

  const cases = [
    ["PROJECT_NAME", "MyApp"],
    ["PROJECT_NAME", "1app"],
    ["PROJECT_NAME", ""],
    ["BASE_URL", "http://api.myapp.example"],
    ["BASE_URL", "not a url"],
    ["TRUSTED_ORIGINS", "http://localhost:3000,myapp://"],
    ["TRUSTED_ORIGINS", "http://127.0.0.1:8787"],
    ["INBOX_TTL_DAYS", "0"],
    ["INBOX_TTL_DAYS", "1.5"],
    ["INBOX_TTL_DAYS", "91"],
    ["MAIL_FROM", ""],
    ["APP_SCHEME", ""],
    ["EMAIL_PASSWORD", "false"],
    ["SESSION_ACTIVITY", "no"],
    ["EMAIL_SENDING", "false"],
    ["SESSION_REFRESH_DAYS", "0"],
    ["SESSION_REFRESH_DAYS", "15"],
    ["SESSION_REFRESH_DAYS", "1.5"],
    ["CUSTOM_DOMAIN", "https://api.myapp.example"],
    ["CUSTOM_DOMAIN", "myapp.me.workers.dev"],
    ["CUSTOM_DOMAIN", "API.myapp.example"],
    ["APP_NAME", "x".repeat(41)],
    ["APP_NAME", "My\nApp"],
  ];
  for (const [key, value] of cases) {
    it(`rejects ${key}=${JSON.stringify(value)}`, () => {
      const problems = validate({ ...valid, [key]: value });
      assert.equal(problems.length, 1, problems.join("; "));
      assert.match(problems[0], new RegExp(key));
    });
  }
});

describe("secretsPayload", () => {
  const sa = { project_id: "p", client_email: "e@p.iam", private_key: "-----KEY-----\nabc\n" };
  const files = { "sa.json": JSON.stringify(sa, null, 2) };
  const readFile = (path) => files[path];

  it("sends every secret, with empty ones as null so wrangler deletes them", () => {
    const payload = secretsPayload(
      { ...valid, TURNSTILE_SECRET_KEY: "", GITHUB_CLIENT_ID: "gh" },
      readFile,
    );
    assert.equal(payload.BETTER_AUTH_SECRET, "auth-secret");
    assert.equal(payload.GITHUB_CLIENT_ID, "gh");
    assert.equal(payload.GOOGLE_CLIENT_ID, null);
    assert.equal(payload.FCM_SERVICE_ACCOUNT, null);
    assert.equal(payload.TURNSTILE_SECRET_KEY, null);
    assert.equal(payload.BASE_URL, undefined);
  });

  it("puts the service account JSON from its file on one line", () => {
    const payload = secretsPayload({ ...valid, FCM_SERVICE_ACCOUNT_FILE: "sa.json" }, readFile);
    assert.equal(payload.FCM_SERVICE_ACCOUNT, JSON.stringify(sa));
  });

  it("rejects a service account file without a private key", () => {
    files["bad.json"] = JSON.stringify({ project_id: "p", client_email: "e" });
    assert.throws(
      () => secretsPayload({ ...valid, FCM_SERVICE_ACCOUNT_FILE: "bad.json" }, readFile),
      /private_key/,
    );
  });
});

describe("ensureDevVars", () => {
  it("fills empty local secrets once and never replaces one", () => {
    const home = process.cwd();
    process.chdir(mkdtempSync(join(tmpdir(), "devvars-")));
    try {
      writeFileSync(".dev.vars.example", "BETTER_AUTH_SECRET=\nPUSH_API_KEY=\nOTHER=\n");
      assert.equal(
        ensureDevVars(() => "s1"),
        true,
      );
      assert.equal(
        readFileSync(".dev.vars", "utf8"),
        "BETTER_AUTH_SECRET=s1\nPUSH_API_KEY=s1\nOTHER=\n",
      );
      assert.equal(
        ensureDevVars(() => "s2"),
        false,
      );
      writeFileSync(".dev.vars", "BETTER_AUTH_SECRET=kept\nPUSH_API_KEY=\n");
      ensureDevVars(() => "s3");
      assert.equal(readFileSync(".dev.vars", "utf8"), "BETTER_AUTH_SECRET=kept\nPUSH_API_KEY=s3\n");
    } finally {
      process.chdir(home);
    }
  });
});

it("wrangler.jsonc runs every cron EdgeBase handles; an app may add its own", () => {
  for (const cron of Object.values(CRONS)) assert.ok(template.triggers.crons.includes(cron), cron);
});

it("an env file rewrite keeps the example's key order, then extra keys, and stays private", () => {
  const file = join(mkdtempSync(join(tmpdir(), "envfile-")), ".env.production");
  writeFileSync(`${file}.example`, "PROJECT_NAME=\nBASE_URL=\nADMIN_EMAIL=\n");
  writeFileSync(file, "ADMIN_EMAIL='a@x.io'\nEXTRA='1'\nPROJECT_NAME='myapp'\n");
  const env = readEnvFile(file);
  assert.deepEqual(Object.keys(env), ["PROJECT_NAME", "BASE_URL", "ADMIN_EMAIL", "EXTRA"]);
  writeEnvFile(file, env);
  const written = readFileSync(file, "utf8");
  assert.deepEqual(
    [...written.matchAll(/^([A-Z_]+)=/gm)].map((m) => m[1]),
    Object.keys(env),
  );
  assert.deepEqual(parseEnv(readFileSync(file, "utf8")), env);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});
