import { base64url, sha256 } from "../src/http";

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function uint16BE(n: number): Uint8Array {
  return new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
}

function uint32BE(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function cborText(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length < 24) return concatBytes(new Uint8Array([0x60 | bytes.length]), bytes);
  return concatBytes(new Uint8Array([0x78, bytes.length]), bytes);
}

function cborBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 24) return concatBytes(new Uint8Array([0x40 | bytes.length]), bytes);
  if (bytes.length < 256) return concatBytes(new Uint8Array([0x58, bytes.length]), bytes);
  return concatBytes(
    new Uint8Array([0x59, (bytes.length >> 8) & 0xff, bytes.length & 0xff]),
    bytes,
  );
}

function derInteger(raw: Uint8Array): Uint8Array {
  let start = 0;
  while (start < raw.length - 1 && raw[start] === 0) start++;
  const trimmed = raw.subarray(start);
  const body = (trimmed[0] ?? 0) & 0x80 ? concatBytes(new Uint8Array([0x00]), trimmed) : trimmed;
  return concatBytes(new Uint8Array([0x02, body.length]), body);
}

/** Converts Web Crypto's 64-byte IEEE P1363 ECDSA signature `(r || s)` into WebAuthn ASN.1 DER. */
function p1363ToDer(sig: Uint8Array): Uint8Array {
  const r = derInteger(sig.subarray(0, 32));
  const s = derInteger(sig.subarray(32, 64));
  return concatBytes(new Uint8Array([0x30, r.length + s.length]), r, s);
}

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export type VirtualPasskey = {
  credentialId: string;
  sign: (opts: {
    challenge: string;
    origin: string;
    rpId: string;
    userVerified?: boolean;
    counter?: number;
  }) => Promise<Record<string, unknown>>;
};

/**
 * Creates a real Web Crypto P-256 software WebAuthn authenticator (`fmt: "none"`) so tests run the
 * genuine `@simplewebauthn/server` CBOR, COSE, origin, RP ID, UV-flag and counter checks.
 */
export async function createVirtualPasskey(opts: {
  challenge: string;
  origin: string;
  rpId: string;
  userVerified?: boolean;
  backedUp?: boolean;
  aaguid?: string;
}): Promise<{
  registrationResponse: Record<string, unknown>;
  authenticator: VirtualPasskey;
}> {
  const keyPair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const rawPub = new Uint8Array(
    (await crypto.subtle.exportKey("raw", keyPair.publicKey)) as ArrayBuffer,
  );
  const x = rawPub.subarray(1, 33);
  const y = rawPub.subarray(33, 65);

  // COSE_Key map (5 items): { 1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y }
  const coseKey = concatBytes(
    new Uint8Array([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01]),
    new Uint8Array([0x21]),
    cborBytes(x),
    new Uint8Array([0x22]),
    cborBytes(y),
  );

  const credBytes = crypto.getRandomValues(new Uint8Array(24));
  const credentialId = base64url(credBytes);
  const rpIdHash = new Uint8Array(await sha256(opts.rpId));
  const uv = opts.userVerified ?? true;
  const backedUp = opts.backedUp ?? true;
  const baseFlags = 0x01 | (uv ? 0x04 : 0x00) | (backedUp ? 0x18 : 0x00);
  const regFlags = new Uint8Array([baseFlags | 0x40]);
  const aaguidBytes = uuidToBytes(opts.aaguid ?? "fbfc3007-154e-4ecc-8c0b-6e020557d7bd");

  const authData = concatBytes(
    rpIdHash,
    regFlags,
    uint32BE(0),
    aaguidBytes,
    uint16BE(credBytes.length),
    credBytes,
    coseKey,
  );

  // CBOR map (3 items): { "fmt": "none", "attStmt": {}, "authData": <bytes> }
  const attestationObject = concatBytes(
    new Uint8Array([0xa3]),
    cborText("fmt"),
    cborText("none"),
    cborText("attStmt"),
    new Uint8Array([0xa0]),
    cborText("authData"),
    cborBytes(authData),
  );

  const clientDataBytes = new TextEncoder().encode(
    JSON.stringify({
      type: "webauthn.create",
      challenge: opts.challenge,
      origin: opts.origin,
      crossOrigin: false,
    }),
  );

  let currentCounter = 0;

  return {
    registrationResponse: {
      id: credentialId,
      rawId: credentialId,
      type: "public-key",
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: base64url(clientDataBytes),
        attestationObject: base64url(attestationObject),
        transports: ["internal", "hybrid"],
      },
    },
    authenticator: {
      credentialId,
      async sign(signOpts) {
        currentCounter = signOpts.counter ?? currentCounter + 1;
        const signUv = signOpts.userVerified ?? true;
        const assertionFlags = new Uint8Array([
          0x01 | (signUv ? 0x04 : 0x00) | (backedUp ? 0x18 : 0x00),
        ]);
        const assertionAuthData = concatBytes(
          new Uint8Array(await sha256(signOpts.rpId)),
          assertionFlags,
          uint32BE(currentCounter),
        );
        const getClientDataStr = JSON.stringify({
          type: "webauthn.get",
          challenge: signOpts.challenge,
          origin: signOpts.origin,
          crossOrigin: false,
        });
        const getClientData = new TextEncoder().encode(getClientDataStr);
        const clientDataHash = new Uint8Array(await sha256(getClientDataStr));
        const signedPayload = concatBytes(assertionAuthData, clientDataHash);
        const rawSig = new Uint8Array(
          await crypto.subtle.sign(
            { name: "ECDSA", hash: "SHA-256" },
            keyPair.privateKey,
            signedPayload as Uint8Array<ArrayBuffer>,
          ),
        );
        return {
          id: credentialId,
          rawId: credentialId,
          type: "public-key",
          authenticatorAttachment: "platform",
          response: {
            authenticatorData: base64url(assertionAuthData),
            clientDataJSON: base64url(getClientData),
            signature: base64url(p1363ToDer(rawSig)),
          },
        };
      },
    },
  };
}
