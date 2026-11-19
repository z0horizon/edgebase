import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  accessibleOnColor,
  contrastRatio,
  normalizeHex,
  parseAccentPreference,
  resolveAccentTokens,
} from "../src/lib/accent.ts";
import { parseAuthUrl } from "../src/lib/auth-url.ts";
import {
  clearSessionDrafts,
  describeDevice,
  describeNetwork,
  fillPreview,
  networkShifted,
  SEND_RECIPIENTS_KEY,
  viewKeyFromHash,
} from "../src/lib/state.ts";
import {
  base64urlToBytes,
  bytesToBase64url,
  describePasskey,
  toCreationOptions,
  toRequestOptions,
} from "../src/lib/webauthn.ts";

const VIEWS = { users: 1, send: 1, pushes: 1, templates: 1, account: 1 };

describe("viewKeyFromHash", () => {
  it("picks known views and falls back for unknown or Object.prototype hashes", () => {
    assert.equal(viewKeyFromHash("#send", VIEWS, "users"), "send");
    assert.equal(viewKeyFromHash("", VIEWS, "users"), "users");
    assert.equal(viewKeyFromHash("#nope", VIEWS, "send"), "send");
    assert.equal(viewKeyFromHash("#toString", VIEWS, "users"), "users");
    assert.equal(viewKeyFromHash("#constructor", VIEWS, "users"), "users");
    assert.equal(viewKeyFromHash("#__proto__", VIEWS, "users"), "users");
  });
});

describe("fillPreview", () => {
  it("replaces own vars and leaves missing or Object.prototype placeholders intact", () => {
    assert.equal(
      fillPreview("Hi {{name}}, {{missing}}, {{toString}}, {{constructor}}", { name: "Ada" }),
      "Hi Ada, {{missing}}, {{toString}}, {{constructor}}",
    );
  });
});

describe("clearSessionDrafts", () => {
  it("removes queued send recipients from sessionStorage on sign-out", () => {
    const store = new Map([[SEND_RECIPIENTS_KEY, '{"u1":"a@x.io"}']]);
    clearSessionDrafts({
      removeItem: (key) => {
        store.delete(key);
      },
    });
    assert.equal(store.has(SEND_RECIPIENTS_KEY), false);
  });
});

describe("describeDevice, describeNetwork, networkShifted", () => {
  it("summarizes common browsers, OSes, and custom app user-agents", () => {
    assert.equal(
      describeDevice(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      ),
      "Chrome on macOS",
    );
    assert.equal(
      describeDevice(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
      ),
      "Safari on iOS",
    );
    assert.equal(describeDevice("EdgeBaseExpo/2.0"), "EdgeBaseExpo/2.0");
    assert.equal(describeDevice(null), "Unknown device");
  });

  it("formats location, ISP/ASN, and IP cleanly with partial telemetry", () => {
    assert.equal(
      describeNetwork({
        city: "Hanoi",
        country: "VN",
        asOrganization: "VNPT Corp",
        asn: 45899,
        ipAddress: "203.0.113.10",
      }),
      "Hanoi, VN · VNPT Corp (AS45899) · 203.0.113.10",
    );
    assert.equal(
      describeNetwork({ asn: 13335, ipAddress: "198.51.100.1" }),
      "AS13335 · 198.51.100.1",
    );
    assert.equal(describeNetwork({}), "Unknown network");
  });

  it("flags when a session or trusted device moved to another ASN or country since creation", () => {
    assert.equal(
      networkShifted({ createdAsn: 45899, asn: 7552, createdCountry: "VN", country: "VN" }),
      true,
    );
    assert.equal(
      networkShifted({ createdAsn: 45899, asn: 45899, createdCountry: "VN", country: "VN" }),
      false,
    );
    assert.equal(networkShifted({ createdAsn: null, asn: 45899 }), false);
  });
});

describe("webauthn helpers", () => {
  it("round-trips binary bytes through unpadded base64url", () => {
    const sample = new Uint8Array([0, 1, 2, 62, 63, 253, 254, 255]);
    const encoded = bytesToBase64url(sample);
    assert.equal(encoded.includes("+"), false);
    assert.equal(encoded.includes("/"), false);
    assert.equal(encoded.includes("="), false);
    assert.deepEqual(Array.from(base64urlToBytes(encoded)), Array.from(sample));
  });

  it("converts JSON WebAuthn creation and request options into ArrayBuffer options", () => {
    const createOpts = toCreationOptions({
      challenge: bytesToBase64url(new Uint8Array([9, 8, 7])),
      rp: { name: "EdgeBase", id: "api.test" },
      user: {
        id: bytesToBase64url(new Uint8Array([1, 2, 3, 4])),
        name: "a@x.io",
        displayName: "a@x.io",
      },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      excludeCredentials: [
        { id: bytesToBase64url(new Uint8Array([5, 6])), type: "public-key", transports: ["usb"] },
      ],
    });
    assert.deepEqual(Array.from(new Uint8Array(createOpts.challenge)), [9, 8, 7]);
    assert.deepEqual(Array.from(new Uint8Array(createOpts.user.id)), [1, 2, 3, 4]);
    assert.deepEqual(
      Array.from(new Uint8Array(createOpts.excludeCredentials?.[0]?.id ?? new ArrayBuffer(0))),
      [5, 6],
    );

    const reqOpts = toRequestOptions({
      challenge: bytesToBase64url(new Uint8Array([11, 22])),
      rpId: "api.test",
      allowCredentials: [{ id: bytesToBase64url(new Uint8Array([33, 44])), type: "public-key" }],
    });
    assert.deepEqual(Array.from(new Uint8Array(reqOpts.challenge)), [11, 22]);
    assert.deepEqual(
      Array.from(new Uint8Array(reqOpts.allowCredentials?.[0]?.id ?? new ArrayBuffer(0))),
      [33, 44],
    );
  });

  it("labels passkeys by custom name, known AAGUID provider, or fallback", () => {
    assert.equal(
      describePasskey({ name: "Work MacBook", aaguid: "bada5566-a7aa-401f-bd96-45619a55120d" }),
      "Work MacBook",
    );
    assert.equal(
      describePasskey({ name: null, aaguid: "bada5566-a7aa-401f-bd96-45619a55120d" }),
      "1Password",
    );
    assert.equal(
      describePasskey({ name: null, aaguid: "b84e4048-15dc-4dd0-8640-f4f60813c8af" }),
      "NordPass",
    );
    assert.equal(
      describePasskey({ name: "", aaguid: "00000000-0000-0000-0000-000000000000" }),
      "Passkey",
    );
  });
});

describe("accent palette resolution", () => {
  it("normalizes custom hex inputs and parses presets safely", () => {
    assert.equal(normalizeHex("0ea5e9"), "#0EA5E9");
    assert.equal(normalizeHex("invalid"), null);
    assert.equal(parseAccentPreference("cobalt"), "cobalt");
    assert.equal(parseAccentPreference("custom:#0ea5e9"), "custom:#0EA5E9");
    assert.equal(parseAccentPreference("custom:nope"), "ocean");
  });

  it("guarantees accessible text contrast for presets and arbitrary custom accents", () => {
    assert.equal(accessibleOnColor("#FACC15"), "#141518");
    assert.equal(accessibleOnColor("#2554D9"), "#FFFFFF");
    const lightCustom = resolveAccentTokens("custom:#FACC15", false);
    assert.ok(contrastRatio(lightCustom.primaryInk, "#FFFFFF") >= 4.5);
    assert.ok(contrastRatio(lightCustom.accentForeground, lightCustom.accent) >= 4.5);
    const darkCustom = resolveAccentTokens("custom:#1E293B", true);
    assert.ok(contrastRatio(darkCustom.primaryInk, "#181A1D") >= 4.5);
  });
});

describe("parseAuthUrl", () => {
  it("extracts password reset token and cleans URL without triggering OAuth error", () => {
    const res = parseAuthUrl("?token=abc123", "#reset-password");
    assert.equal(res.state.initialMode, "reset");
    assert.equal(res.state.resetToken, "abc123");
    assert.equal(res.state.oauthError, "");
    assert.equal(res.cleanedHash, "#reset-password");
  });

  it("distinguishes invalid reset and verification links from OAuth errors", () => {
    const resetErr = parseAuthUrl("?error=INVALID_TOKEN", "#reset-password");
    assert.equal(resetErr.state.initialMode, "reset");
    assert.ok(resetErr.state.authError.length > 0);
    assert.equal(resetErr.state.oauthError, "");

    const verifyErr = parseAuthUrl("?error=INVALID_TOKEN", "#verified");
    assert.equal(verifyErr.state.initialMode, "verified");
    assert.ok(verifyErr.state.authError.includes("verification"));
    assert.equal(verifyErr.state.oauthError, "");

    const bareTokenErr = parseAuthUrl("?error=INVALID_TOKEN", "");
    assert.equal(bareTokenErr.state.initialMode, "reset");
    assert.equal(bareTokenErr.state.oauthError, "");

    const oauthErr = parseAuthUrl("?error=access_denied", "");
    assert.equal(oauthErr.state.initialMode, "signin");
    assert.equal(oauthErr.state.oauthError, "Sign-in failed (access denied).");
  });

  it("checks contrast of all presets including dark Indigo button contrast", () => {
    const darkIndigo = resolveAccentTokens("indigo", true);
    assert.ok(contrastRatio(darkIndigo.primary, darkIndigo.primaryForeground) >= 4.5);
  });

  it("maps hash shortcuts for sign-up, forgot-password, and email verification", () => {
    assert.equal(parseAuthUrl("", "#signup").state.initialMode, "signup");
    assert.equal(parseAuthUrl("", "#forgot-password").state.initialMode, "forgot");
    assert.equal(parseAuthUrl("", "#verified").state.initialMode, "verified");
  });
});

describe("sharedRequest", async () => {
  const { sharedRequest } = await import("../src/lib/shared-request.ts");

  it("asks once for every caller until refresh, and does not keep a failure", async () => {
    let calls = 0;
    let fail = true;
    const shared = sharedRequest(async () => {
      calls++;
      if (fail) throw new Error("down");
      return calls;
    });
    await assert.rejects(shared.get(), /down/);
    fail = false;
    const [a, b] = await Promise.all([shared.get(), shared.get()]);
    assert.equal(a, 2);
    assert.equal(b, 2);
    assert.equal(await shared.get(), 2);
    assert.equal(await shared.refresh(), 3);
    assert.equal(await shared.get(), 3);
    assert.equal(calls, 3);
  });

  it("an old failure does not drop a newer refresh", async () => {
    let calls = 0;
    let rejectFirst = () => {};
    const shared = sharedRequest(
      () =>
        new Promise((resolve, reject) => {
          calls++;
          if (calls === 1) rejectFirst = () => reject(new Error("late"));
          else resolve(calls);
        }),
    );
    const first = shared.get();
    assert.equal(await shared.refresh(), 2);
    rejectFirst();
    await assert.rejects(first, /late/);
    assert.equal(await shared.get(), 2);
    assert.equal(calls, 2);
  });
});
