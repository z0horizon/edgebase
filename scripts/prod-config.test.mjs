import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { experimental_readRawConfig } from "wrangler";
import {
  parseEnvFile,
  renderConfig,
  secretsPayload,
  serializeEnvFile,
  validate,
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

  it("takes vars from the env and keeps everything else from the template", () => {
    assert.deepEqual(out.vars, {
      BASE_URL: valid.BASE_URL,
      TRUSTED_ORIGINS: valid.TRUSTED_ORIGINS,
      APP_SCHEME: valid.APP_SCHEME,
      INBOX_TTL_DAYS: valid.INBOX_TTL_DAYS,
      MAIL_FROM: valid.MAIL_FROM,
    });
    for (const key of ["triggers", "ratelimits", "compatibility_date", "send_email", "main"]) {
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
      /run pnpm bootstrap first/,
    );
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
    assert.deepEqual(parseEnvFile(serializeEnvFile(env)), env);
  });

  it("rejects a value with a newline", () => {
    assert.throws(() => serializeEnvFile({ K: "a\nb" }), /K/);
  });
});

describe("validate", () => {
  it("accepts a complete production env", () => {
    assert.deepEqual(validate(valid), []);
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
    ["MAIL_FROM", ""],
    ["APP_SCHEME", ""],
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
    const payload = secretsPayload({ ...valid, GITHUB_CLIENT_ID: "gh" }, readFile);
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
