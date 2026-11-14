import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, it } from "node:test";
import { adminStatements, executeSql } from "./admin.mjs";

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

  it("drops an existing admin's TOTP only when asked", () => {
    const resetSql = adminStatements({ ...base, userId: "u1", resetTwoFactor: true }).join(";");
    assert.match(
      resetSql,
      /twoFactorEnabled = 0 WHERE id = 'u1'.*DELETE FROM twoFactor WHERE userId = 'u1'/,
    );
    assert.doesNotMatch(adminStatements({ ...base, userId: "u1" }).join(";"), /twoFactor/);
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
