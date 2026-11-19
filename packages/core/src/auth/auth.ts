import { expo } from "@better-auth/expo";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { admin, bearer, captcha, oneTimeToken, organization, twoFactor } from "better-auth/plugins";
import * as v from "valibot";
import { appName, sessionRefreshDays } from "../config";
import { deleteUserInbox } from "../inbox/queries";
import { sendMail } from "../mail";
import { deleteUserOpens } from "../push/stats";
import { LocaleSchema } from "../push/types";
import { bindAppCallback } from "./app-callback";
import { type ClientNetwork, extractClientNetwork } from "./network";
import { passkeyPolicyPlugin } from "./passkey-policy";
import {
  edgebaseSecurityPlugin,
  type RequestSecurityState,
  revokeAllTrustedDevices,
  revokeAllTrustedDevicesStatements,
  type TwoFactorMethod,
  wipeCredentialsState,
} from "./trusted-devices";

const DAY_SECONDS = 86_400;
const FRESH_SESSION_SECONDS = 15 * 60;

const UserPatchSchema = v.object({
  name: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(120))),
  email: v.optional(v.pipe(v.string(), v.minLength(3), v.maxLength(254))),
  image: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(2048)))),
  banReason: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(500)))),
});

const OrgPatchSchema = v.object({
  name: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(120))),
  slug: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(64))),
  logo: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(2048)))),
});

function assertValidPatch<S extends v.GenericSchema>(schema: S, data: unknown): void {
  const parsed = v.safeParse(schema, data);
  if (!parsed.success) {
    throw new APIError("BAD_REQUEST", { message: v.summarize(parsed.issues) });
  }
}

function assertBoundedOrg(data: Record<string, unknown> | undefined): void {
  if (!data) return;
  assertValidPatch(OrgPatchSchema, data);
  const meta = data["metadata"];
  if (meta !== undefined && meta !== null) {
    const serialized = typeof meta === "string" ? meta : JSON.stringify(meta);
    if (serialized.length > 4096) {
      throw new APIError("BAD_REQUEST", { message: "Organization metadata exceeds 4 KB" });
    }
  }
}

const pickStr = (obj: Record<string, unknown>, key: string): string | null =>
  typeof obj[key] === "string" ? (obj[key] as string) : null;

const pickNum = (obj: Record<string, unknown>, key: string): number | null =>
  typeof obj[key] === "number" ? (obj[key] as number) : null;

const has = (...values: (string | undefined)[]) => values.every((value) => value?.trim());
const csv = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** Only providers whose credentials are set, so a project can start with any subset. */
export function configuredProviders(env: Env) {
  const googleIds = csv(env.GOOGLE_CLIENT_ID);
  return {
    ...(googleIds.length > 0 &&
      has(env.GOOGLE_CLIENT_SECRET) && {
        google: {
          clientId: googleIds,
          clientSecret: env.GOOGLE_CLIENT_SECRET.trim(),
          // Sign-out only ends our session; without this Google silently reuses its signed-in account.
          prompt: "select_account" as const,
        },
      }),
    ...(has(env.APPLE_CLIENT_ID, env.APPLE_CLIENT_SECRET) && {
      apple: {
        clientId: env.APPLE_CLIENT_ID.trim(),
        clientSecret: env.APPLE_CLIENT_SECRET.trim(),
        appBundleIdentifier: env.APPLE_APP_BUNDLE_IDENTIFIER?.trim(),
      },
    }),
    ...(has(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET) && {
      github: {
        clientId: env.GITHUB_CLIENT_ID.trim(),
        clientSecret: env.GITHUB_CLIENT_SECRET.trim(),
      },
    }),
  };
}

/** Email and password sign-in is on unless EMAIL_PASSWORD is "off" (e.g. a Google-only app). */
export const emailPasswordEnabled = (env: Env) =>
  env.EMAIL_PASSWORD?.trim().toLowerCase() !== "off";

/** TRUSTED_ORIGINS as a list: app schemes (`myapp://`) and web origins. */
export const trustedOrigins = (env: Env) => csv(env.TRUSTED_ORIGINS);

/** HTTP(S) web origins from TRUSTED_ORIGINS (excludes native custom URL schemes). */
export const webTrustedOrigins = (env: Env) =>
  trustedOrigins(env).filter((o) => o.startsWith("https://") || o.startsWith("http://"));

/** Expected WebAuthn ceremony origins: BASE_URL origin, web TRUSTED_ORIGINS, plus optional PASSKEY_ORIGINS. */
export function passkeyOrigins(env: Env): string[] {
  const base = new URL(env.BASE_URL);
  const extra = (env as { PASSKEY_ORIGINS?: string | undefined }).PASSKEY_ORIGINS ?? "";
  return Array.from(
    new Set([
      base.origin,
      ...(base.hostname === "localhost" ? ["http://localhost:5173"] : []),
      ...webTrustedOrigins(env),
      ...extra
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean),
    ]),
  );
}

const SOCIAL_PROVIDERS = new Set(["google", "apple", "github"]);

/**
 * The provider behind the endpoint creating a session: the OAuth callback, or a native app's ID
 * token sign-in. Anything else (password, TOTP, impersonation) is null.
 */
export function socialProviderOf(
  ctx: {
    path?: string | undefined;
    params?: Record<string, string | undefined> | undefined;
    body?: unknown;
  } | null,
): string | null {
  const id = ctx?.path?.startsWith("/callback/")
    ? ctx.params?.["id"]
    : ctx?.path === "/sign-in/social"
      ? (ctx.body as { provider?: unknown } | undefined)?.provider
      : undefined;
  return typeof id === "string" && SOCIAL_PROVIDERS.has(id) ? id : null;
}

export function signInProviderOf(
  ctx: {
    path?: string | undefined;
    params?: Record<string, string | undefined> | undefined;
    body?: unknown;
  } | null,
): string | null {
  if (ctx?.path === "/passkey/verify-authentication") return "passkey";
  return socialProviderOf(ctx);
}

export function twoFactorMethodOf(
  ctx: { path?: string | undefined } | null,
  state: RequestSecurityState,
  userId: string,
): TwoFactorMethod | null {
  if (ctx?.path === "/two-factor/verify-totp") return "totp";
  if (ctx?.path === "/two-factor/verify-backup-code") return "backup_code";
  if (ctx?.path === "/sign-in/email" && state.trustedDeviceUserId === userId) {
    return "trusted_device";
  }
  return null;
}

/** Built per request: bindings only exist once a request arrives. */
export function createAuth(env: Env, ctx: Pick<ExecutionContext, "waitUntil">, req?: Request) {
  const net: ClientNetwork = extractClientNetwork(req);
  const securityState: RequestSecurityState = {
    trustedDeviceUserId: null,
    matchedDevice: null,
    bridgeTrustId: null,
    hadTrustCookie: false,
    matchedAnomaly: false,
    hadTwoFactorCookie: false,
    requestedTrustDevice: false,
    bootstrapAdminPasskeySessionId: null,
  };
  const mail = (to: string, subject: string, text: string) => {
    ctx.waitUntil(sendMail(env, { to, subject, text }));
  };
  return betterAuth({
    database: env.DB,
    basePath: "/api/auth",
    baseURL: env.BASE_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: trustedOrigins(env),
    advanced: {
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
    emailAndPassword: {
      enabled: emailPasswordEnabled(env),
      requireEmailVerification: true,
      sendResetPassword: async ({ user, url }) =>
        mail(user.email, "Reset your password", `Reset your password: ${url}`),
      onPasswordReset: async ({ user }) => {
        await wipeCredentialsState(env.DB, user.id, {
          passwordChangedAt: new Date().toISOString(),
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: async ({ user, url }) =>
        mail(user.email, "Verify your email", `Verify your email: ${url}`),
    },
    socialProviders: configuredProviders(env),
    // Sessions stay in D1 with no cookie cache so a revoked session fails on the very next request.
    session: {
      expiresIn: 30 * DAY_SECONDS,
      updateAge: sessionRefreshDays(env) * DAY_SECONDS,
      freshAge: FRESH_SESSION_SECONDS,
      additionalFields: {
        signInProvider: { type: "string", required: false, input: false },
        asn: { type: "number", required: false, input: false },
        asOrganization: { type: "string", required: false, input: false },
        country: { type: "string", required: false, input: false },
        city: { type: "string", required: false, input: false },
        createdIp: { type: "string", required: false, input: false },
        createdAsn: { type: "number", required: false, input: false },
        createdAsOrganization: { type: "string", required: false, input: false },
        createdCountry: { type: "string", required: false, input: false },
        createdCity: { type: "string", required: false, input: false },
        lastActiveAt: { type: "string", required: false, input: false },
        twoFactorMethod: { type: "string", required: false, input: false },
        twoFactorVerifiedAt: { type: "string", required: false, input: false },
      },
    },
    // Its built-in limiter is per-isolate memory; AUTH_RL in middleware does this job.
    rateLimit: { enabled: false },
    user: {
      additionalFields: {
        marketingOptIn: { type: "boolean", required: false, defaultValue: false },
        locale: { type: "string", required: false, validator: { input: v.nullable(LocaleSchema) } },
        twoFactorEnabledAt: { type: "string", required: false, input: false },
        passwordChangedAt: { type: "string", required: false, input: false },
      },
      deleteUser: { enabled: true },
    },
    hooks: {
      after: createAuthMiddleware(async (hookCtx) => {
        if (!hookCtx.path.startsWith("/callback/")) return;
        const sessionId = hookCtx.context.newSession?.session.id;
        if (!sessionId) return;
        await bindAppCallback(
          env,
          sessionId,
          hookCtx.context.responseHeaders?.get("location"),
          Date.now(),
        );
      }),
    },
    // A database hook, not deleteUser.afterDelete, so admin remove-user cleans up too.
    databaseHooks: {
      session: {
        create: {
          before: async (session, hookCtx) => {
            const nowIso = new Date().toISOString();
            const existing = session as Record<string, unknown>;
            const ip = net.ipAddress ?? session.ipAddress ?? null;
            const freshMethod = twoFactorMethodOf(hookCtx, securityState, session.userId);
            const provider = signInProviderOf(hookCtx) ?? pickStr(existing, "signInProvider");
            const isPasskeyVerify = hookCtx?.path === "/passkey/verify-authentication";
            const disabled2fa = hookCtx?.path === "/two-factor/disable";
            const method = disabled2fa
              ? null
              : (freshMethod ?? pickStr(existing, "twoFactorMethod"));
            const verifiedAt = disabled2fa
              ? provider === "passkey"
                ? pickStr(existing, "twoFactorVerifiedAt")
                : null
              : freshMethod || isPasskeyVerify
                ? nowIso
                : method || provider === "passkey"
                  ? pickStr(existing, "twoFactorVerifiedAt")
                  : null;
            return {
              data: {
                ...session,
                ipAddress: ip,
                userAgent: net.userAgent ?? session.userAgent ?? null,
                signInProvider: provider,
                asn: net.asn,
                asOrganization: net.asOrganization,
                country: net.country,
                city: net.city,
                createdIp: pickStr(existing, "createdIp") ?? ip,
                createdAsn: pickNum(existing, "createdAsn") ?? net.asn,
                createdAsOrganization:
                  pickStr(existing, "createdAsOrganization") ?? net.asOrganization,
                createdCountry: pickStr(existing, "createdCountry") ?? net.country,
                createdCity: pickStr(existing, "createdCity") ?? net.city,
                lastActiveAt: nowIso,
                twoFactorMethod: method,
                twoFactorVerifiedAt: verifiedAt,
              },
            };
          },
        },
        update: {
          before: async (updatePayload) => ({
            data: {
              ...updatePayload,
              ...(net.ipAddress !== null && { ipAddress: net.ipAddress }),
              ...(net.asn !== null && { asn: net.asn }),
              ...(net.asOrganization !== null && { asOrganization: net.asOrganization }),
              ...(net.country !== null && { country: net.country }),
              ...(net.city !== null && { city: net.city }),
              lastActiveAt: new Date().toISOString(),
            },
          }),
        },
      },
      account: {
        create: {
          // A social session skips TOTP, so a provider account may join an admin only from that
          // admin's own session that already passed two-factor (link-social), never by matching
          // email at sign-in: owning the inbox, or the password alone, must not reach admin features.
          before: async (account, hookCtx) => {
            if (account.providerId === "credential") return;
            const role = await env.DB.prepare("SELECT role FROM user WHERE id = ?")
              .bind(account.userId)
              .first<string | null>("role");
            if (role !== "admin") return;
            if (!hookCtx) return false;
            const current = await getSessionFromCtx<SessionUser, Session["session"]>(hookCtx, {
              disableRefresh: true,
            }).catch(() => null);
            if (current?.user.id !== account.userId || adminNeedsTwoFactor(current)) return false;
          },
          after: async (account) => {
            if (account.providerId === "credential" && account.password) {
              await env.DB.prepare("UPDATE user SET passwordChangedAt = ? WHERE id = ?")
                .bind(new Date().toISOString(), account.userId)
                .run();
            }
          },
        },
      },
      user: {
        create: {
          before: async (user) => {
            assertValidPatch(UserPatchSchema, user);
          },
        },
        update: {
          before: async (user) => {
            assertValidPatch(UserPatchSchema, user);
          },
          after: async (user) => {
            const u = user as { banned?: boolean | null; twoFactorEnabled?: boolean | null };
            if (u.twoFactorEnabled === false) {
              await env.DB.batch([
                env.DB.prepare("UPDATE user SET twoFactorEnabledAt = NULL WHERE id = ?").bind(
                  user.id,
                ),
                env.DB.prepare("DELETE FROM twoFactor WHERE userId = ?").bind(user.id),
                ...revokeAllTrustedDevicesStatements(env.DB, user.id),
              ]);
              return;
            }
            if (u.banned) {
              await revokeAllTrustedDevices(env.DB, user.id);
            }
          },
        },
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
      // Roles: "user" (default) and "admin"; the first admin is set in D1 (see docs/deployment.md).
      admin(),
      // TOTP and backup codes for email + password sign-in; the authenticator app shows APP_NAME.
      twoFactor({ issuer: appName(env) }),
      // Hardware/platform WebAuthn credentials with mandatory biometric/PIN user verification.
      passkey({
        rpName: appName(env),
        rpID: new URL(env.BASE_URL).hostname,
        origin: passkeyOrigins(env),
        authenticatorSelection: {
          residentKey: "preferred",
          userVerification: "required",
        },
      }),
      // Order matters: the security plugin's before-hook records the two-factor cookie that the
      // policy plugin's gate on /two-factor/verify-totp reads.
      edgebaseSecurityPlugin(env, ctx, net, securityState),
      passkeyPolicyPlugin(env, ctx, net, securityState),
      organization({
        // Bounds organization and member rows per user; pending invitations are capped at 100 per
        // organization by default and expire after 48 h.
        organizationLimit: 10,
        membershipLimit: 100,
        organizationHooks: {
          beforeCreateOrganization: async ({ organization: org }) => {
            assertBoundedOrg(org as Record<string, unknown>);
          },
          beforeUpdateOrganization: async ({ organization: org }) => {
            assertBoundedOrg(org as Record<string, unknown>);
          },
        },
        sendInvitationEmail: async ({ id, email, organization: org, inviter }) =>
          mail(
            email,
            `Join ${org.name}`,
            `${inviter.user.name} invited you to ${org.name}. Open the app to accept: ${env.APP_SCHEME}://invitation?id=${id}`,
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
      // Kept last so its after-hook observes cookies emitted by earlier plugins.
      expo(),
    ],
  });
}

type Auth = ReturnType<typeof createAuth>;
export type Session = Auth["$Infer"]["Session"];
export type SessionUser = Session["user"];

/**
 * Admin features need a second factor: the account's TOTP for a password session, the provider's
 * own sign-in for a social one. A leaked password alone must not reach users, bans or pushes.
 */
export const adminNeedsTwoFactor = ({ user, session }: Session) =>
  user.role === "admin" && !user.twoFactorEnabled && !session.signInProvider;
