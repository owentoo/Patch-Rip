import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";

function getSecret(): string {
  const secret =
    process.env.PROOF_TOKEN_SECRET || process.env.SHOPIFY_API_SECRET;
  if (!secret) {
    throw new Error(
      "PROOF_TOKEN_SECRET (or SHOPIFY_API_SECRET) must be set for signing customer review tokens.",
    );
  }
  return secret;
}

// We store a 32-byte random nonce as Order.signedCustomerToken; the public URL
// uses `<orderId>.<nonce>.<hmac>` so a leaked token reveals only that one
// order and can be revoked by rotating the nonce.

export function generateNonce(): string {
  return randomBytes(24).toString("base64url");
}

export function signCustomerToken(orderId: string, nonce: string): string {
  const payload = `${orderId}.${nonce}`;
  const sig = createHmac("sha256", getSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export interface ParsedToken {
  orderId: string;
  nonce: string;
}

export function verifyCustomerToken(token: string): ParsedToken | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [orderId, nonce, sig] = parts;
  const expected = createHmac("sha256", getSecret())
    .update(`${orderId}.${nonce}`)
    .digest("base64url");
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return { orderId, nonce };
}
