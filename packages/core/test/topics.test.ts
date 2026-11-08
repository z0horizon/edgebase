import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resetFcmCacheForTests } from "../src/push/fcm";
import {
  authed,
  call,
  freshIp,
  json,
  makeServiceAccount,
  PASSWORD,
  signUpVerified,
} from "./helpers";

let SA = "";
beforeAll(async () => {
  SA = (await makeServiceAccount()).json;
});
afterEach(() => {
  vi.restoreAllMocks();
  resetFcmCacheForTests();
});

/** Google's OAuth and Instance ID endpoints; returns the Instance ID requests made. */
function stubGoogle(iid: Response = Response.json({ results: [{}] })) {
  const asked: Request[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    if (req.url.startsWith("https://oauth2.googleapis.com")) {
      return Response.json({ access_token: "oauth-at", expires_in: 3600 });
    }
    asked.push(req);
    return iid.clone();
  });
  return asked;
}

const topic = (
  token: string,
  path: string,
  body: object,
  bindings = { ...env, FCM_SERVICE_ACCOUNT: SA },
) => call(`/v1/topics/${path}`, authed(token, json(body)), bindings);

describe("web topic subscription", () => {
  it("subscribes the caller's token with an OAuth2 token, not a server key", async () => {
    const { userId, token } = await signUpVerified("topic-a@x.io");
    await env.DB.prepare("INSERT INTO device VALUES ('web-1', ?, 'web', 0)").bind(userId).run();
    const asked = stubGoogle();
    expect((await topic(token, "news/subscribe", { token: "web-1" })).status).toBe(204);
    const [req] = asked;
    expect(req?.url).toBe("https://iid.googleapis.com/iid/v1:batchAdd");
    expect(req?.headers.get("authorization")).toBe("Bearer oauth-at");
    expect(req?.headers.get("access_token_auth")).toBe("true");
    expect(await req?.json()).toEqual({ to: "/topics/news", registration_tokens: ["web-1"] });

    expect((await topic(token, "news/unsubscribe", { token: "web-1" })).status).toBe(204);
    expect(asked[1]?.url).toBe("https://iid.googleapis.com/iid/v1:batchRemove");
  });

  it("a token of another user answers 404 without calling Google", async () => {
    const owner = await signUpVerified("topic-b@x.io");
    const other = await signUpVerified("topic-c@x.io");
    await env.DB.prepare("INSERT INTO device VALUES ('web-2', ?, 'web', 0)")
      .bind(owner.userId)
      .run();
    stubGoogle();
    expect((await topic(other.token, "news/subscribe", { token: "web-2" })).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["an error result", Response.json({ results: [{ error: "INVALID_ARGUMENT" }] })],
    ["a non-2xx answer", Response.json({ error: "x" }, { status: 401 })],
  ])("%s from Instance ID answers 502", async (_name, iid) => {
    const { userId, token } = await signUpVerified(`topic-${iid.status}@x.io`);
    await env.DB.prepare("INSERT INTO device VALUES (?, ?, 'web', 0)")
      .bind(`web-${iid.status}`, userId)
      .run();
    stubGoogle(iid);
    const res = await topic(token, "news/subscribe", { token: `web-${iid.status}` });
    expect(res.status).toBe(502);
  });

  it("an invalid topic answers 400 and no service account answers 503", async () => {
    const { token } = await signUpVerified("topic-d@x.io");
    expect((await topic(token, "bad%20topic!/subscribe", { token: "t" })).status).toBe(400);
    const unset = { ...env, FCM_SERVICE_ACCOUNT: "" };
    expect((await topic(token, "news/subscribe", { token: "t" }, unset)).status).toBe(503);
  });

  it("is limited per user and leaves the IP's sign-in budget alone", async () => {
    const { userId, token } = await signUpVerified("topic-rl@x.io");
    await env.DB.prepare("INSERT INTO device VALUES ('web-rl', ?, 'web', 0)").bind(userId).run();
    stubGoogle();
    const ip = { "cf-connecting-ip": freshIp() };
    let limited = false;
    // The window may reset mid-test, so allow twice the limit.
    for (let i = 0; i < 41 && !limited; i++) {
      const res = await call(
        "/v1/topics/news/subscribe",
        authed(token, json({ token: "web-rl" }, { headers: ip })),
        {
          ...env,
          FCM_SERVICE_ACCOUNT: SA,
        },
      );
      limited = res.status === 429;
    }
    expect(limited).toBe(true);
    const signIn = await call(
      "/api/auth/sign-in/email",
      json({ email: "topic-rl@x.io", password: PASSWORD }, { headers: ip }),
    );
    expect(signIn.status).toBe(200);
  });
});
