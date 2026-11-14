import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clearSessionDrafts,
  fillPreview,
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
