import { expo } from "@better-auth/expo";
import { betterAuth } from "better-auth";
import { bearer, oneTimeToken } from "better-auth/plugins";
import { deleteUserInbox } from "../inbox/queries";
import { sendMail } from "../mail";

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
      },
      deleteUser: {
        enabled: true,
        afterDelete: async (user) => deleteUserInbox(env.INBOX_DB, user.id),
      },
    },
    plugins: [bearer(), oneTimeToken({ disableClientRequest: true, storeToken: "hashed" }), expo()],
  });
}

export type Auth = ReturnType<typeof createAuth>;
export type SessionUser = Auth["$Infer"]["Session"]["user"];
