import { sharedRequest } from "./shared-request";
import {
  type CreationOptionsJSON,
  type RequestOptionsJSON,
  serializeAssertion,
  serializeAttestation,
  toCreationOptions,
  toRequestOptions,
} from "./webauthn";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Same-origin JSON call; the session cookie rides along. */
export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    credentials: "same-origin",
    headers: {
      ...init.headers,
      ...(init.body !== undefined && { "content-type": "application/json" }),
    },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // A proxy or platform error page, not one of ours; the status below says enough.
  }
  if (!res.ok) {
    // EdgeBase routes answer { error: { message } }, Better Auth routes { message }.
    throw new ApiError(
      data?.error?.message ?? data?.message ?? `Request failed (${res.status})`,
      res.status,
    );
  }
  return data as T;
}

export type User = {
  id: string;
  email: string;
  name: string;
  role?: string | null;
  banned?: boolean | null;
  banReason?: string | null;
  twoFactorEnabled?: boolean | null;
  twoFactorEnabledAt?: string | null;
  passwordChangedAt?: string | null;
  emailVerified: boolean;
  createdAt: string;
};

export type SessionRecord = {
  id: string;
  current?: boolean;
  userId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  asn?: number | null;
  asOrganization?: string | null;
  country?: string | null;
  city?: string | null;
  createdIp?: string | null;
  createdAsn?: number | null;
  createdAsOrganization?: string | null;
  createdCountry?: string | null;
  createdCity?: string | null;
  lastActiveAt?: string | null;
  signInProvider?: string | null;
  twoFactorMethod?: "totp" | "backup_code" | "trusted_device" | null;
  twoFactorVerifiedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};

export type TrustedDevice = {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  asn: number | null;
  asOrganization: string | null;
  country: string | null;
  city: string | null;
  createdIp: string | null;
  createdAsn: number | null;
  createdAsOrganization?: string | null;
  createdCountry: string | null;
  createdCity?: string | null;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
  current: boolean;
};

export type PasskeyRecord = {
  id: string;
  name?: string | null;
  deviceType: string;
  backedUp: boolean;
  aaguid?: string | null;
  createdAt?: string | null;
};

/** `GET /v1/me`: the signed-in user, and whether admin features first need TOTP or a passkey. */
export type Me = User & { adminNeedsTwoFactor: boolean };

export type Text = { title: string; body: string };
export type Category = "transactional" | "marketing";

export type Template = Text & {
  name: string;
  data?: Record<string, string>;
  category?: Category;
  translations?: Record<string, Text>;
  updatedAt: number;
};

/** `GET /v1/templates`, shared by the Templates and Send pages; Templates refreshes it on change. */
export const templatesRequest = sharedRequest(() =>
  api<{ templates: Template[] }>("/v1/templates").then((r) => r.templates),
);

export type PushStats = {
  id: number;
  category: Category;
  users: number;
  sent: number;
  failed: number;
  opened: number;
  sendAt: number;
};

/** A page of users, newest first; `email` narrows to addresses containing it. */
export function listUsers({
  limit,
  offset = 0,
  email,
}: {
  limit: number;
  offset?: number;
  email?: string;
}) {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    sortBy: "createdAt",
    sortDirection: "desc",
  });
  if (email) {
    params.set("searchField", "email");
    params.set("searchOperator", "contains");
    params.set("searchValue", email);
  }
  return api<{ users: User[]; total: number }>(`/api/auth/admin/list-users?${params}`);
}

function normalizeWebAuthnError(err: unknown, ceremony: "register" | "authenticate"): Error {
  if (err instanceof DOMException) {
    if (err.name === "NotAllowedError" || err.name === "AbortError") {
      return new Error("Passkey prompt was cancelled or timed out");
    }
    if (ceremony === "register" && err.name === "InvalidStateError") {
      return new Error("This passkey is already registered on your account");
    }
  }
  return err instanceof Error ? err : new Error("Passkey operation failed");
}

export async function registerPasskey(name?: string): Promise<PasskeyRecord> {
  const trimmed = name?.trim();
  const options = await api<CreationOptionsJSON>("/api/auth/passkey/generate-register-options");
  let credential: Credential | null;
  try {
    credential = await navigator.credentials.create({
      publicKey: toCreationOptions(options),
    });
  } catch (err) {
    throw normalizeWebAuthnError(err, "register");
  }
  if (!(credential instanceof PublicKeyCredential)) {
    throw new Error("Passkey creation was cancelled");
  }
  return api<PasskeyRecord>("/api/auth/passkey/verify-registration", {
    method: "POST",
    body: {
      response: serializeAttestation(credential),
      ...(trimmed && { name: trimmed }),
    },
  });
}

export async function authenticateWithPasskey(): Promise<void> {
  const options = await api<RequestOptionsJSON>("/api/auth/passkey/generate-authenticate-options");
  let credential: Credential | null;
  try {
    credential = await navigator.credentials.get({
      publicKey: toRequestOptions(options),
    });
  } catch (err) {
    throw normalizeWebAuthnError(err, "authenticate");
  }
  if (!(credential instanceof PublicKeyCredential)) {
    throw new Error("Passkey sign-in was cancelled");
  }
  await api("/api/auth/passkey/verify-authentication", {
    method: "POST",
    body: { response: serializeAssertion(credential) },
  });
}

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong";
