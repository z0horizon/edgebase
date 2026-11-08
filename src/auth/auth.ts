import { expo } from "@better-auth/expo";
import { betterAuth } from "better-auth";
import { admin, bearer, captcha, oneTimeToken, organization, twoFactor } from "better-auth/plugins";
import * as v from "valibot";
import { deleteUserInbox } from "../inbox/queries";
import { sendMail } from "../mail";
import { deleteUserOpens } from "../push/stats";
import { LocaleSchema } from "../push/types";

const DAY_SECONDS = 86_400;

const has = (...values: (string | undefined)[]) => values.every((value) => value?.trim());

/** Only providers whose credentials are set, so a project can start with any subset. */
function configuredProviders(env: Env) {
  return {
    ...(has(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET) && {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        // Sign-out only ends our session; without this Google silently reuses its signed-in account.
        prompt: "select_account" as const,
      },
    }),
    ...(has(env.APPLE_CLIENT_ID, env.APPLE_CLIENT_SECRET) && {
      apple: {
        clientId: env.APPLE_CLIENT_ID,
        clientSecret: env.APPLE_CLIENT_SECRET,
        appBundleIdentifier: env.APPLE_APP_BUNDLE_IDENTIFIER,
      },
    }),
    ...(has(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET) && {
      github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET },
    }),
  };
}

/** Built per request: bindings only exist once a request arrives. */
export function createAuth(env: Env, ctx: Pick<ExecutionContext, "waitUntil">) {
  const mail = (to: string, subject: string, text: string) => {
    ctx.waitUntil(sendMail(env, { to, subject, text }));
  };
  return betterAuth({
    database: env.DB,
    basePath: "/api/auth",
    baseURL: env.BASE_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: env.TRUSTED_ORIGINS.split(",").map((o) => o.trim()),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      sendResetPassword: async ({ user, url }) =>
        mail(user.email, "Reset your password", `Reset your password: ${url}`),
    },
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: async ({ user, url }) =>
        mail(user.email, "Verify your email", `Verify your email: ${url}`),
    },
    socialProviders: configuredProviders(env),
    // Sessions stay in D1 with no cookie cache so a revoked session fails on the very next request.
    session: { expiresIn: 30 * DAY_SECONDS, updateAge: DAY_SECONDS },
    // Its built-in limiter is per-isolate memory; AUTH_RL in middleware does this job.
    rateLimit: { enabled: false },
    user: {
      additionalFields: {
        marketingOptIn: { type: "boolean", required: false, defaultValue: false },
        locale: { type: "string", required: false, validator: { input: v.nullable(LocaleSchema) } },
      },
      deleteUser: { enabled: true },
    },
    // A database hook, not deleteUser.afterDelete, so admin remove-user cleans up too.
    databaseHooks: {
      user: {
        delete: {
          after: async (user) => {
            await Promise.all([
              deleteUserInbox(env.INBOX_DB, user.id),
              deleteUserOpens(env.DB, user.id),
            ]);
          },
        },
      },
    },
    plugins: [
      bearer(),
      oneTimeToken({ disableClientRequest: true, storeToken: "hashed" }),
      expo(),
      // Roles: "user" (default) and "admin"; the first admin is set in D1 (see docs/deployment.md).
      admin(),
      // TOTP and backup codes for email + password sign-in; the authenticator app shows the API host.
      twoFactor({ issuer: new URL(env.BASE_URL).hostname }),
      organization({
        // Bounds organization and member rows per user; pending invitations are capped at 100 per
        // organization by default and expire after 48 h.
        organizationLimit: 10,
        membershipLimit: 100,
        sendInvitationEmail: async ({ id, email, organization, inviter }) =>
          mail(
            email,
            `Join ${organization.name}`,
            `${inviter.user.name} invited you to ${organization.name}. Open the app to accept: ${env.APP_SCHEME}://invitation?id=${id}`,
          ),
      }),
      // Off until a key is set: the per-IP rate limit covers one machine, Turnstile covers botnets
      // sending sign-up and reset emails to random addresses.
      ...(has(env.TURNSTILE_SECRET_KEY)
        ? [
            captcha({
              provider: "cloudflare-turnstile",
              secretKey: env.TURNSTILE_SECRET_KEY,
              endpoints: ["/sign-up/email", "/request-password-reset", "/send-verification-email"],
            }),
          ]
        : []),
    ],
  });
}

type Auth = ReturnType<typeof createAuth>;
export type SessionUser = Auth["$Infer"]["Session"]["user"];
