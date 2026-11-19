import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { sendMail } from "../src/mail";

function capture(appName: string | undefined) {
  const sent: { subject: string }[] = [];
  const bindings = {
    ...env,
    APP_NAME: appName,
    MAIL: { send: async (msg: { subject: string }) => void sent.push(msg) },
  } as unknown as Env;
  return { bindings, sent };
}

it("prefixes every subject with APP_NAME, cleaned of line breaks and capped at 40 characters", async () => {
  const cases: [string | undefined, string][] = [
    ["My App", "My App: Hi"],
    [undefined, "EdgeBase: Hi"],
    ["  ", "EdgeBase: Hi"],
    ["Evil\r\nBcc: x@y.z", "EvilBcc: x@y.z: Hi"],
    ["x".repeat(50), `${"x".repeat(40)}: Hi`],
  ];
  for (const [name, subject] of cases) {
    const { bindings, sent } = capture(name);
    await sendMail(bindings, { to: "a@b.c", subject: "Hi", text: "t" });
    expect(sent[0]?.subject).toBe(subject);
  }
});

it("EMAIL_SENDING=off sends nothing and does not touch the binding", async () => {
  const { bindings, sent } = capture("My App");
  await sendMail({ ...bindings, EMAIL_SENDING: "off", MAIL: undefined } as unknown as Env, {
    to: "a@b.c",
    subject: "Hi",
    text: "t",
  });
  await sendMail(
    { ...bindings, EMAIL_SENDING: " OFF " },
    { to: "a@b.c", subject: "Hi", text: "t" },
  );
  expect(sent).toHaveLength(0);
  await sendMail({ ...bindings, EMAIL_SENDING: "on" }, { to: "a@b.c", subject: "Hi", text: "t" });
  expect(sent).toHaveLength(1);
});
