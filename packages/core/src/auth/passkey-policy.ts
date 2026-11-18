import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import type { ClientNetwork } from "./network";
import { notifyPasskeyAdded } from "./security-alerts";
import { headersWithBearerCookie, type RequestSecurityState } from "./trusted-devices";

export const MAX_PASSKEYS_PER_USER = 20;
const MAX_PASSKEY_NAME_LEN = 64;
const FRESH_SESSION_MS = 15 * 60_000;

/**
 * Enforces session freshness (15 min), admin 2FA / first-passkey bootstrap, per-user cap (20),
 * name length bounds, and publicKey/credentialID stripping across `/api/auth/passkey/*`.
 */
export function passkeyPolicyPlugin(
  env: Env,
  execCtx: Pick<ExecutionContext, "waitUntil">,
  net: ClientNetwork,
  state: RequestSecurityState,
): BetterAuthPlugin {
  return {
    id: "edgebase-passkey-policy",
    hooks: {
      before: [
        {
          matcher: (context) =>
            context.path === "/passkey/list-user-passkeys" ||
            context.path === "/passkey/generate-register-options" ||
            context.path === "/passkey/verify-registration" ||
            context.path === "/passkey/update-passkey" ||
            context.path === "/passkey/delete-passkey",
          handler: createAuthMiddleware(async (ctx) => {
            const cookieName = ctx.context.authCookies.sessionToken.name;
            const lookupHeaders = await headersWithBearerCookie(
              ctx.headers,
              cookieName,
              ctx.context.secret,
            );
            const current = await getSessionFromCtx<
              {
                id: string;
                email: string;
                role?: string | null;
                twoFactorEnabled?: boolean | null;
              },
              { id: string; createdAt: Date | string; signInProvider?: string | null }
            >(
              { ...ctx, headers: lookupHeaders },
              { disableRefresh: true, disableCookieCache: true },
            ).catch(() => null);
            // Fail closed: every endpoint matched here requires a valid session.
            if (!current) {
              throw new APIError("UNAUTHORIZED", {
                code: "UNAUTHORIZED",
                message: "Unauthorized",
              });
            }

            const unverifiedAdmin =
              current.user.role === "admin" &&
              !current.user.twoFactorEnabled &&
              !current.session.signInProvider;

            if (ctx.path === "/passkey/list-user-passkeys") {
              if (unverifiedAdmin) {
                throw new APIError("FORBIDDEN", {
                  code: "TWO_FACTOR_REQUIRED",
                  message: "Turn on two-factor authentication first",
                });
              }
              return;
            }

            const createdAtMs = new Date(current.session.createdAt).getTime();
            if (Date.now() - createdAtMs >= FRESH_SESSION_MS) {
              throw new APIError("FORBIDDEN", {
                code: "SESSION_NOT_FRESH",
                message: "Session is not fresh",
              });
            }

            const queryName = (ctx.query as Record<string, unknown> | undefined)?.["name"];
            const body = ctx.body as Record<string, unknown> | undefined;
            const bodyName = body?.["name"];
            for (const candidate of [queryName, bodyName]) {
              if (typeof candidate === "string" && candidate.trim().length > MAX_PASSKEY_NAME_LEN) {
                throw new APIError("BAD_REQUEST", {
                  code: "INVALID_PASSKEY_NAME",
                  message: `Passkey name must be at most ${MAX_PASSKEY_NAME_LEN} characters`,
                });
              }
            }

            if (ctx.path === "/passkey/update-passkey" || ctx.path === "/passkey/delete-passkey") {
              if (unverifiedAdmin) {
                throw new APIError("FORBIDDEN", {
                  code: "TWO_FACTOR_REQUIRED",
                  message: "Turn on two-factor authentication first",
                });
              }
              if (
                ctx.path === "/passkey/delete-passkey" &&
                current.user.role === "admin" &&
                !current.user.twoFactorEnabled
              ) {
                const factorState = await env.DB.prepare(
                  `SELECT
                     (SELECT count(*) FROM passkey WHERE userId = ?1) AS passkeys,
                     EXISTS(SELECT 1 FROM account WHERE userId = ?1 AND providerId = 'credential') AS hasPassword`,
                )
                  .bind(current.user.id)
                  .first<{ passkeys: number; hasPassword: number }>();
                if (factorState && factorState.hasPassword === 1 && factorState.passkeys <= 1) {
                  throw new APIError("BAD_REQUEST", {
                    code: "LAST_ADMIN_FACTOR",
                    message:
                      "Add another passkey or enable two-factor before removing your last passkey",
                  });
                }
              }
              return;
            }

            const count =
              (await env.DB.prepare("SELECT count(*) AS n FROM passkey WHERE userId = ?")
                .bind(current.user.id)
                .first<number>("n")) ?? 0;

            if (unverifiedAdmin) {
              if (count > 0) {
                throw new APIError("FORBIDDEN", {
                  code: "TWO_FACTOR_REQUIRED",
                  message: "Sign in with an existing passkey or two-factor first",
                });
              }
              state.bootstrapAdminPasskeySessionId = current.session.id;
            }

            if (count >= MAX_PASSKEYS_PER_USER) {
              throw new APIError("BAD_REQUEST", {
                code: "PASSKEY_LIMIT_REACHED",
                message: `Maximum of ${MAX_PASSKEYS_PER_USER} passkeys per account`,
              });
            }

            // Cloudflare D1 has no interactive SQL transactions (`runWithTransaction`); never let
            // `verify-registration` spin up a second session transactionally.
            if (ctx.path === "/passkey/verify-registration" && body?.["createSession"]) {
              return { context: { body: { ...body, createSession: false } } };
            }
          }),
        },
      ],
      after: [
        {
          matcher: (context) =>
            context.path === "/passkey/list-user-passkeys" ||
            context.path === "/passkey/verify-registration",
          handler: createAuthMiddleware(async (ctx) => {
            if (ctx.context.returned instanceof Error) return;

            if (ctx.path === "/passkey/list-user-passkeys") {
              if (Array.isArray(ctx.context.returned)) {
                return ctx.json(
                  ctx.context.returned.map((item: Record<string, unknown>) => {
                    const { publicKey: _pk, credentialID: _cid, ...safe } = item;
                    return safe;
                  }),
                );
              }
              return;
            }

            const active = ctx.context.session;
            if (!active) return;
            const now = Date.now();
            const nowIso = new Date(now).toISOString();
            const createdId = (ctx.context.returned as { id?: unknown } | null)?.id;

            if (
              state.bootstrapAdminPasskeySessionId &&
              active.session.id === state.bootstrapAdminPasskeySessionId
            ) {
              const postCount =
                (await env.DB.prepare("SELECT count(*) AS n FROM passkey WHERE userId = ?")
                  .bind(active.user.id)
                  .first<number>("n")) ?? 0;
              if (postCount > 1) {
                if (typeof createdId === "string" && createdId) {
                  await env.DB.prepare("DELETE FROM passkey WHERE id = ? AND userId = ?")
                    .bind(createdId, active.user.id)
                    .run();
                }
                throw new APIError("FORBIDDEN", {
                  code: "TWO_FACTOR_REQUIRED",
                  message: "Sign in with an existing passkey or two-factor first",
                });
              }
              await env.DB.prepare(
                "UPDATE session SET signInProvider = 'passkey', twoFactorVerifiedAt = ? WHERE id = ?",
              )
                .bind(nowIso, active.session.id)
                .run();
            } else {
              await env.DB.prepare(
                `DELETE FROM passkey
                 WHERE userId = ?1 AND id NOT IN (
                   SELECT id FROM passkey
                   WHERE userId = ?1
                   ORDER BY createdAt DESC, rowid DESC
                   LIMIT ?2
                 )`,
              )
                .bind(active.user.id, MAX_PASSKEYS_PER_USER)
                .run();
            }

            const body = ctx.body as { name?: unknown } | undefined;
            const name = typeof body?.name === "string" ? body.name.trim() : null;
            execCtx.waitUntil(
              notifyPasskeyAdded(env, active.user, name, net, now).catch((error) =>
                console.error("passkey alert failed", error),
              ),
            );
          }),
        },
      ],
    },
  };
}
