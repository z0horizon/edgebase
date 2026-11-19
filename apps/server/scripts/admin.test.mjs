import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, it } from "node:test";
import {
  adminAction,
  adminStatements,
  executeSql,
  findAdminCandidate,
  passwordIsOff,
  promoteStatements,
} from "./admin.mjs";

const base = {
  email: "o'neil@example.com",
  hash: "salt:hash",
  now: Date.UTC(2026, 0, 2),
  ids: { user: "new-user", account: "new-account" },
};

describe("adminStatements", () => {
  it("creates a verified admin with a credential account when the email is new", () => {
    const [user, clear, account] = adminStatements({ ...base, userId: null });
    assert.match(
      user,
      /^INSERT INTO user .*'new-user', 'o''neil', 'o''neil@example.com', 1, 'admin'/,
    );
    assert.match(clear, /userId = 'new-user' AND providerId = 'credential'/);
    assert.match(
      account,
      /'new-account', 'new-user', 'credential', 'new-user', 'salt:hash', '2026-01-02T00:00:00.000Z'/,
    );
  });

  it("promotes, verifies and unbans an existing user and replaces only their password", () => {
    const [user, clear, account] = adminStatements({ ...base, userId: "u1" });
    assert.match(
      user,
      /^UPDATE user SET role = 'admin', emailVerified = 1, banned = 0, .* WHERE id = 'u1'$/,
    );
    assert.match(clear, /^DELETE FROM account WHERE userId = 'u1' AND providerId = 'credential'$/);
    assert.match(account, /'new-account', 'u1', 'credential', 'u1', 'salt:hash'/);
  });

  it("drops an existing admin's TOTP and passkeys only when asked", () => {
    const resetSql = adminStatements({ ...base, userId: "u1", resetTwoFactor: true }).join(";");
    assert.match(
      resetSql,
      /twoFactorEnabled = 0, twoFactorEnabledAt = NULL WHERE id = 'u1'.*DELETE FROM twoFactor WHERE userId = 'u1'.*DELETE FROM passkey WHERE userId = 'u1'.*DELETE FROM trusted_device WHERE user_id = 'u1'/,
    );
    assert.doesNotMatch(adminStatements({ ...base, userId: "u1" }).join(";"), /twoFactor|passkey/);
  });

  it("stamps passwordChangedAt and revokes prior sessions and trusted devices when resetting an admin's password", () => {
    const created = adminStatements({ ...base, userId: null }).join(";");
    assert.match(created, /passwordChangedAt/);
    const updated = adminStatements({ ...base, userId: "u1" }).join(";");
    assert.match(updated, /passwordChangedAt = '2026-01-02T00:00:00\.000Z'/);
    assert.match(updated, /DELETE FROM session WHERE userId = 'u1'/);
    assert.match(updated, /DELETE FROM trusted_device WHERE user_id = 'u1'/);
  });
});

describe("promoteStatements", () => {
  const now = Date.UTC(2026, 0, 2);

  it("makes an existing user an admin, unbans them and revokes their sessions, keeping sign-in methods", () => {
    const statements = promoteStatements({ userId: "o'u1", now });
    assert.deepEqual(statements, [
      "UPDATE user SET role = 'admin', banned = 0, updatedAt = '2026-01-02T00:00:00.000Z' WHERE id = 'o''u1'",
      "DELETE FROM session WHERE userId = 'o''u1'",
      "DELETE FROM trusted_device WHERE user_id = 'o''u1'",
      "DELETE FROM verification WHERE identifier GLOB 'trust-device-*' AND value = 'o''u1'",
    ]);
    assert.doesNotMatch(statements.join(";"), /account|passkey/);
  });

  it("drops TOTP only when asked, and never passkeys, which may be how they sign in", () => {
    const reset = promoteStatements({ userId: "u1", now, resetTwoFactor: true }).join(";");
    assert.match(
      reset,
      /twoFactorEnabled = 0, twoFactorEnabledAt = NULL WHERE id = 'u1'.*DELETE FROM twoFactor WHERE userId = 'u1'/,
    );
    assert.doesNotMatch(reset, /passkey/);
    assert.doesNotMatch(promoteStatements({ userId: "u1", now }).join(";"), /twoFactor/);
  });
});

describe("adminAction", () => {
  const social = { id: "u1", role: "user", passwordless: 1 };
  const passwordOnly = { id: "u2", role: "user", passwordless: 0 };

  it("leaves an existing user alone on a bootstrap rerun, whatever the mode", () => {
    for (const passwordOff of [true, false]) {
      assert.equal(adminAction({ found: social, passwordOff, keepExisting: true }), "keep");
    }
  });

  it("with passwords on, creates or resets a password admin", () => {
    assert.equal(
      adminAction({ found: undefined, passwordOff: false, keepExisting: false }),
      "password",
    );
    assert.equal(
      adminAction({ found: passwordOnly, passwordOff: false, keepExisting: false }),
      "password",
    );
    assert.equal(
      adminAction({ found: undefined, passwordOff: false, keepExisting: true }),
      "password",
    );
  });

  it("with passwords off, promotes only a user who can sign in without one", () => {
    assert.equal(adminAction({ found: social, passwordOff: true, keepExisting: false }), "promote");
    assert.equal(
      adminAction({ found: passwordOnly, passwordOff: true, keepExisting: false }),
      "wait",
    );
    assert.equal(adminAction({ found: undefined, passwordOff: true, keepExisting: false }), "wait");
    assert.equal(adminAction({ found: undefined, passwordOff: true, keepExisting: true }), "wait");
  });
});

describe("passwordIsOff", () => {
  it("deployed: .env.production wins, else the wrangler.jsonc var", () => {
    const remote = (value, templateVar) =>
      passwordIsOff({ remote: true, env: { EMAIL_PASSWORD: value }, devVars: {}, templateVar });
    assert.equal(remote("off", "on"), true);
    assert.equal(remote("", "off"), true);
    assert.equal(remote("", "on"), false);
    assert.equal(remote("OFF", "on"), true);
  });

  it("locally: a key in .dev.vars wins even when empty, else the wrangler.jsonc var", () => {
    const local = (devVars, templateVar) =>
      passwordIsOff({ remote: false, env: {}, devVars, templateVar });
    assert.equal(local({ EMAIL_PASSWORD: "off" }, "on"), true);
    assert.equal(local({ EMAIL_PASSWORD: "" }, "off"), false);
    assert.equal(local({}, "off"), true);
    assert.equal(local({}, "on"), false);
  });
});

describe("findAdminCandidate", () => {
  it("counts a provider account or a passkey, never the password, as a way in", () => {
    const query = findAdminCandidate("o'neil@example.com");
    assert.match(query, /providerId <> 'credential'/);
    assert.match(query, /FROM passkey WHERE userId = user\.id/);
    assert.match(query, /WHERE email = 'o''neil@example\.com'$/);
  });
});

describe("executeSql", () => {
  it("passes SQL through a 0600 temporary --file instead of --command argv and cleans it up", () => {
    let seenArgs = [];
    let seenSql = "";
    let seenMode = 0;
    let seenFile = "";
    const out = executeSql(
      ["SELECT 1", "INSERT INTO account VALUES ('secret-hash')"],
      ["--local"],
      (args) => {
        seenArgs = args;
        const idx = args.indexOf("--file");
        seenFile = args[idx + 1] ?? "";
        seenSql = readFileSync(seenFile, "utf8");
        seenMode = statSync(seenFile).mode & 0o777;
        return { status: 0, stdout: '[{"results":[{"ok":1}]}]', stderr: "" };
      },
    );
    assert.equal(seenArgs.includes("--command"), false);
    assert.equal(
      seenArgs.some((a) => a.includes("secret-hash")),
      false,
    );
    assert.equal(seenMode, 0o600);
    assert.equal(seenSql, "SELECT 1;\nINSERT INTO account VALUES ('secret-hash');\n");
    assert.equal(existsSync(seenFile), false);
    assert.deepEqual(out, [{ results: [{ ok: 1 }] }]);
  });

  it("removes the temporary SQL file even when wrangler fails", () => {
    let seenFile = "";
    assert.throws(() =>
      executeSql(["SELECT 'secret'"], ["--local"], (args) => {
        seenFile = args[args.indexOf("--file") + 1] ?? "";
        return { status: 1, stdout: "", stderr: "boom" };
      }),
    );
    assert.equal(existsSync(seenFile), false);
  });
});
