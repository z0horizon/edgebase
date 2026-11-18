import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clearSessionDrafts,
  describeDevice,
  describeNetwork,
  fillPreview,
  networkShifted,
  SEND_RECIPIENTS_KEY,
  viewKeyFromHash,
} from "../src/lib/state.ts";

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
