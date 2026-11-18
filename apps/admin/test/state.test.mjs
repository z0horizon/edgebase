import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clearSessionDrafts,
  describeDevice,
  describeNetwork,
  extractPlaceholders,
  fillPreview,
  networkShifted,
  routeFromHash,
  SEND_RECIPIENTS_KEY,
  SEND_TEMPLATE_KEY,
} from "../src/lib/state.ts";
import {
  base64urlToBytes,
  bytesToBase64url,
  describePasskey,
  toCreationOptions,
  toRequestOptions,
} from "../src/lib/webauthn.ts";

const VIEWS = { users: 1, notifications: 1, templates: 1, account: 1 };
const ALIASES = { pushes: "notifications", send: "notifications" };

describe("routeFromHash", () => {
  it("resolves known views, subviews, legacy aliases, and rejects unknown or Object.prototype hashes", () => {
    assert.deepEqual(routeFromHash("", VIEWS, "users", ALIASES), {
      view: "users",
      subview: null,
    });
    assert.deepEqual(routeFromHash("#nope", VIEWS, "notifications", ALIASES), {
      view: "notifications",
      subview: null,
    });
    assert.deepEqual(routeFromHash("#notifications", VIEWS, "users", ALIASES), {
      view: "notifications",
      subview: null,
    });
    assert.deepEqual(routeFromHash("#notifications/send", VIEWS, "users", ALIASES), {
      view: "notifications",
      subview: "send",
    });
    assert.deepEqual(routeFromHash("#send", VIEWS, "users", ALIASES), {
      view: "notifications",
      subview: "send",
    });
    assert.deepEqual(routeFromHash("#pushes", VIEWS, "users", ALIASES), {
      view: "notifications",
      subview: null,
    });
    assert.deepEqual(routeFromHash("#toString", VIEWS, "users", ALIASES), {
      view: "users",
      subview: null,
    });
    assert.deepEqual(routeFromHash("#constructor", VIEWS, "users", ALIASES), {
      view: "users",
      subview: null,
    });
    assert.deepEqual(routeFromHash("#__proto__/send", VIEWS, "users", ALIASES), {
      view: "users",
      subview: null,
    });
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
  it("removes queued send recipients and template selection from sessionStorage on sign-out", () => {
    const store = new Map([
      [SEND_RECIPIENTS_KEY, '{"u1":"a@x.io"}'],
      [SEND_TEMPLATE_KEY, "order-shipped"],
    ]);
    clearSessionDrafts({
      removeItem: (key) => {
        store.delete(key);
      },
    });
    assert.equal(store.has(SEND_RECIPIENTS_KEY), false);
    assert.equal(store.has(SEND_TEMPLATE_KEY), false);
  });
});

describe("extractPlaceholders", () => {
  it("collects unique placeholder names in order across title, body, data, and translations", () => {
    assert.deepEqual(
      extractPlaceholders({
        title: "Order #{{order}} shipped",
        body: "Arriving {{ eta }} for {{order}}",
        data: { tracking: "{{tracking_id}}" },
        translations: {
          es: { title: "Pedido #{{order}}", body: "Entrega {{eta}} ({{carrier}})" },
        },
      }),
      ["order", "eta", "tracking_id", "carrier"],
    );
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
