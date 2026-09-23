import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Intercom webhook signature verification.
 *
 * Intercom signs every webhook notification with an `X-Hub-Signature` header
 * whose value is `sha1=<hex>`, where `<hex>` is the hexadecimal (40 character)
 * HMAC-SHA1 of the RAW request body keyed with the app's Client Secret (App >
 * Basic Info > Client Secret).
 *
 * Official documentation:
 *   https://developers.intercom.com/docs/webhooks
 *   https://developers.intercom.com/docs/references/webhooks/webhook-models
 *
 * Two things matter and are easy to get wrong:
 *
 *  1. The HMAC must be computed over the exact bytes received. Parsing the JSON
 *     and re-serialising it changes whitespace and key order and will not match.
 *     That is why this function takes a Buffer, and why the route reads the body
 *     with `arrayBuffer()` before any parsing happens.
 *
 *  2. The comparison must be timing-safe, otherwise the byte-by-byte compare
 *     leaks how much of a forged signature was correct.
 *
 * SHA-1 is a legacy choice, but it is what Intercom sends. `sha256=` is accepted
 * here too and preferred when present, so that if/when Intercom upgrades a
 * deployment of this service does not need a code change to keep verifying.
 */

export const SIGNATURE_HEADER = "x-hub-signature";
export const SIGNATURE_HEADER_256 = "x-hub-signature-256";

const ALGORITHMS = {
  sha1: { digest: "sha1", hexLength: 40 },
  sha256: { digest: "sha256", hexLength: 64 },
} as const;

type AlgorithmName = keyof typeof ALGORITHMS;

function isAlgorithmName(value: string): value is AlgorithmName {
  return Object.hasOwn(ALGORITHMS, value);
}

export type SignatureVerification =
  | { valid: true; algorithm: AlgorithmName }
  | { valid: false; reason: "missing_header" | "malformed_header" | "mismatch" };

export interface VerifyOptions {
  /** The exact bytes of the request body, before any parsing. */
  rawBody: Buffer;
  /** Header value, e.g. `sha1=1f2c...`. */
  signatureHeader: string | null | undefined;
  /** The Intercom app's Client Secret. */
  clientSecret: string;
}

export function verifyIntercomSignature(options: VerifyOptions): SignatureVerification {
  const { rawBody, signatureHeader, clientSecret } = options;

  if (typeof signatureHeader !== "string" || signatureHeader.length === 0) {
    return { valid: false, reason: "missing_header" };
  }

  const separator = signatureHeader.indexOf("=");
  if (separator <= 0) return { valid: false, reason: "malformed_header" };

  const algorithmName = signatureHeader.slice(0, separator).trim().toLowerCase();
  const provided = signatureHeader
    .slice(separator + 1)
    .trim()
    .toLowerCase();

  if (!isAlgorithmName(algorithmName)) return { valid: false, reason: "malformed_header" };
  const algorithm = ALGORITHMS[algorithmName];

  if (provided.length !== algorithm.hexLength || !/^[0-9a-f]+$/.test(provided)) {
    return { valid: false, reason: "malformed_header" };
  }

  const expected = createHmac(algorithm.digest, clientSecret).update(rawBody).digest("hex");

  // Both operands are fixed-length lowercase hex at this point, so the lengths
  // always match and timingSafeEqual cannot throw.
  const matches = timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(provided, "utf8"));

  return matches ? { valid: true, algorithm: algorithmName } : { valid: false, reason: "mismatch" };
}

/** Picks the strongest signature header present, preferring SHA-256. */
export function readSignatureHeader(
  get: (name: string) => string | null | undefined,
): string | null {
  return get(SIGNATURE_HEADER_256) ?? get(SIGNATURE_HEADER) ?? null;
}

/** Test/dev helper: produces a header value the way Intercom would. */
export function signPayload(
  rawBody: Buffer | string,
  clientSecret: string,
  algorithm: AlgorithmName = "sha1",
): string {
  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const digest = createHmac(ALGORITHMS[algorithm].digest, clientSecret).update(body).digest("hex");
  return `${algorithm}=${digest}`;
}
