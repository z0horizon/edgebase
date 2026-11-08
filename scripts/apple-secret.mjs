// Prints the client secret Sign in with Apple needs: an ES256 JWT that Apple accepts for at most
// 6 months, so rerun this and update APPLE_CLIENT_SECRET before it expires.
// Usage: node scripts/apple-secret.mjs <teamId> <keyId> <clientId> <path-to-AuthKey.p8>
import { readFileSync } from "node:fs";

const [teamId, keyId, clientId, keyPath] = process.argv.slice(2);
if (!teamId || !keyId || !clientId || !keyPath) {
  console.error("Usage: node scripts/apple-secret.mjs <teamId> <keyId> <clientId> <path-to-.p8>");
  process.exit(1);
}

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const pem = readFileSync(keyPath, "utf8").replace(/-----[^-]+-----|\s/g, "");
const key = await crypto.subtle.importKey(
  "pkcs8",
  Buffer.from(pem, "base64"),
  { name: "ECDSA", namedCurve: "P-256" },
  false,
  ["sign"],
);
const iat = Math.floor(Date.now() / 1000);
const unsigned = [
  { alg: "ES256", kid: keyId },
  { iss: teamId, iat, exp: iat + 180 * 86_400, aud: "https://appleid.apple.com", sub: clientId },
]
  .map((part) => b64url(JSON.stringify(part)))
  .join(".");
// WebCrypto already returns the raw r||s signature JOSE expects.
const signature = await crypto.subtle.sign(
  { name: "ECDSA", hash: "SHA-256" },
  key,
  new TextEncoder().encode(unsigned),
);
process.stdout.write(`${unsigned}.${b64url(new Uint8Array(signature))}\n`);
