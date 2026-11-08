import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { adminStatements } from "./admin.mjs";

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
