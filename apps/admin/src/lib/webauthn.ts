const AAGUID_NAMES: Record<string, string> = {
  "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4": "Google Password Manager",
  "fbfc3007-154e-4ecc-8c0b-6e020557d7bd": "Apple Passwords",
  "dd4ec289-e01d-41c9-bb89-70fa845d4bf2": "iCloud Keychain",
  "08987058-cadc-4b81-b6e1-30de50dcbe96": "Windows Hello",
  "9ddd1817-af5a-4672-a2b9-3e3dd95000a9": "Windows Hello",
  "6028b017-b1d4-4c02-b4b3-afcdafc96bb2": "Windows Hello",
  "bada5566-a7aa-401f-bd96-45619a55120d": "1Password",
  "d548826e-79b4-db40-a3d8-11116f7e8349": "Bitwarden",
  "531126d6-e717-415c-9320-3d9aa6981239": "Dashlane",
  "b78a0a55-6ef8-d246-a042-ba0f6d55050c": "LastPass",
  "b84e4048-15dc-4dd0-8640-f4f60813c8af": "NordPass",
  "50726f74-6f6e-5061-7373-50726f746f6e": "Proton Pass",
  "0ea242b4-43c4-4a1b-8b17-dd6d0b6baec6": "Keeper",
  "53414d53-554e-4700-0000-000000000000": "Samsung Pass",
};

export type CreationOptionsJSON = {
  challenge: string;
  rp: { name: string; id?: string | undefined };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: Array<{ type: "public-key"; alg: number }>;
  timeout?: number | undefined;
  attestation?: AttestationConveyancePreference | undefined;
  authenticatorSelection?: AuthenticatorSelectionCriteria | undefined;
  excludeCredentials?:
    | Array<{
        id: string;
        type: "public-key";
        transports?: AuthenticatorTransport[] | undefined;
      }>
    | undefined;
};

export type RequestOptionsJSON = {
  challenge: string;
  rpId?: string | undefined;
  timeout?: number | undefined;
  userVerification?: UserVerificationRequirement | undefined;
  allowCredentials?:
    | Array<{
        id: string;
        type: "public-key";
        transports?: AuthenticatorTransport[] | undefined;
      }>
    | undefined;
};

export function supportsPasskeys(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential !== "undefined" &&
    typeof navigator?.credentials?.create === "function" &&
    typeof navigator?.credentials?.get === "function"
  );
}

export function bytesToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function base64urlToBytes(input: string): Uint8Array<ArrayBuffer> {
  const base64 = input.replaceAll("-", "+").replaceAll("_", "/");
  const pad = base64.length % 4 === 0 ? "" : "=".repeat(4 - (base64.length % 4));
  const binary = atob(base64 + pad);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function toArrayBuffer(input: string): ArrayBuffer {
  return base64urlToBytes(input).buffer;
}

export function toCreationOptions(json: CreationOptionsJSON): PublicKeyCredentialCreationOptions & {
  challenge: ArrayBuffer;
  user: { id: ArrayBuffer; name: string; displayName: string };
  excludeCredentials?: Array<{
    id: ArrayBuffer;
    type: "public-key";
    transports?: AuthenticatorTransport[];
  }>;
} {
  return {
    challenge: toArrayBuffer(json.challenge),
    rp: json.rp.id ? { name: json.rp.name, id: json.rp.id } : { name: json.rp.name },
    user: {
      id: toArrayBuffer(json.user.id),
      name: json.user.name,
      displayName: json.user.displayName,
    },
    pubKeyCredParams: json.pubKeyCredParams,
    ...(json.timeout !== undefined && { timeout: json.timeout }),
    ...(json.attestation !== undefined && { attestation: json.attestation }),
    ...(json.authenticatorSelection !== undefined && {
      authenticatorSelection: json.authenticatorSelection,
    }),
    ...(json.excludeCredentials && {
      excludeCredentials: json.excludeCredentials.map((cred) => ({
        id: toArrayBuffer(cred.id),
        type: "public-key" as const,
        ...(cred.transports && { transports: cred.transports }),
      })),
    }),
  };
}

export function toRequestOptions(json: RequestOptionsJSON): PublicKeyCredentialRequestOptions & {
  challenge: ArrayBuffer;
  allowCredentials?: Array<{
    id: ArrayBuffer;
    type: "public-key";
    transports?: AuthenticatorTransport[];
  }>;
} {
  return {
    challenge: toArrayBuffer(json.challenge),
    ...(json.rpId !== undefined && { rpId: json.rpId }),
    ...(json.timeout !== undefined && { timeout: json.timeout }),
    ...(json.userVerification !== undefined && { userVerification: json.userVerification }),
    ...(json.allowCredentials && {
      allowCredentials: json.allowCredentials.map((cred) => ({
        id: toArrayBuffer(cred.id),
        type: "public-key" as const,
        ...(cred.transports && { transports: cred.transports }),
      })),
    }),
  };
}

export function serializeAttestation(cred: PublicKeyCredential): Record<string, unknown> {
  const resp = cred.response as AuthenticatorAttestationResponse;
  const transports = typeof resp.getTransports === "function" ? resp.getTransports() : undefined;
  return {
    id: cred.id,
    rawId: bytesToBase64url(new Uint8Array(cred.rawId)),
    type: cred.type,
    ...(cred.authenticatorAttachment && {
      authenticatorAttachment: cred.authenticatorAttachment,
    }),
    response: {
      clientDataJSON: bytesToBase64url(new Uint8Array(resp.clientDataJSON)),
      attestationObject: bytesToBase64url(new Uint8Array(resp.attestationObject)),
      ...(transports && { transports }),
    },
  };
}

export function serializeAssertion(cred: PublicKeyCredential): Record<string, unknown> {
  const resp = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: bytesToBase64url(new Uint8Array(cred.rawId)),
    type: cred.type,
    ...(cred.authenticatorAttachment && {
      authenticatorAttachment: cred.authenticatorAttachment,
    }),
    response: {
      authenticatorData: bytesToBase64url(new Uint8Array(resp.authenticatorData)),
      clientDataJSON: bytesToBase64url(new Uint8Array(resp.clientDataJSON)),
      signature: bytesToBase64url(new Uint8Array(resp.signature)),
      ...(resp.userHandle && {
        userHandle: bytesToBase64url(new Uint8Array(resp.userHandle)),
      }),
    },
  };
}

export function describePasskey(pk: {
  name?: string | null | undefined;
  aaguid?: string | null | undefined;
}): string {
  const custom = pk.name?.trim();
  if (custom) return custom;
  const aaguid = pk.aaguid?.trim().toLowerCase();
  if (aaguid && Object.hasOwn(AAGUID_NAMES, aaguid)) {
    return AAGUID_NAMES[aaguid] ?? "Passkey";
  }
  return "Passkey";
}
