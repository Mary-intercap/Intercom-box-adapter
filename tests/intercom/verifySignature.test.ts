import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  readSignatureHeader,
  signPayload,
  verifyIntercomSignature,
} from "../../src/intercom/verifySignature.js";

const SECRET = "test-client-secret-not-a-real-credential";
const BODY = Buffer.from(JSON.stringify({ topic: "conversation.user.created", id: "abc" }));

describe("verifyIntercomSignature", () => {
  it("accepts a correct sha1 signature over the raw body", () => {
    const result = verifyIntercomSignature({
      rawBody: BODY,
      signatureHeader: signPayload(BODY, SECRET),
      clientSecret: SECRET,
    });
    expect(result).toEqual({ valid: true, algorithm: "sha1" });
  });

  it("accepts a correct sha256 signature", () => {
    const result = verifyIntercomSignature({
      rawBody: BODY,
      signatureHeader: signPayload(BODY, SECRET, "sha256"),
      clientSecret: SECRET,
    });
    expect(result).toEqual({ valid: true, algorithm: "sha256" });
  });

  it("is case-insensitive about the hex digest", () => {
    const header = signPayload(BODY, SECRET).toUpperCase().replace("SHA1", "sha1");
    expect(
      verifyIntercomSignature({ rawBody: BODY, signatureHeader: header, clientSecret: SECRET }),
    ).toMatchObject({ valid: true });
  });

  it("rejects a signature made with the wrong secret", () => {
    const result = verifyIntercomSignature({
      rawBody: BODY,
      signatureHeader: signPayload(BODY, "some-other-secret"),
      clientSecret: SECRET,
    });
    expect(result).toEqual({ valid: false, reason: "mismatch" });
  });

  it("rejects a signature computed over different bytes", () => {
    // This is the re-serialisation trap: same JSON, different whitespace.
    const reserialized = Buffer.from(
      JSON.stringify({ topic: "conversation.user.created", id: "abc" }, null, 2),
    );
    const result = verifyIntercomSignature({
      rawBody: BODY,
      signatureHeader: signPayload(reserialized, SECRET),
      clientSecret: SECRET,
    });
    expect(result).toEqual({ valid: false, reason: "mismatch" });
  });

  it("rejects a missing header", () => {
    for (const header of [null, undefined, ""]) {
      expect(
        verifyIntercomSignature({ rawBody: BODY, signatureHeader: header, clientSecret: SECRET }),
      ).toEqual({ valid: false, reason: "missing_header" });
    }
  });

  it("rejects malformed headers", () => {
    const digest = createHmac("sha1", SECRET).update(BODY).digest("hex");
    const malformed = [
      digest, // no algorithm prefix
      `md5=${digest}`, // unsupported algorithm
      "sha1=", // empty digest
      `sha1=${digest.slice(0, 20)}`, // wrong length
      `sha1=${"z".repeat(40)}`, // not hex
      `=${digest}`, // empty algorithm
    ];
    for (const header of malformed) {
      expect(
        verifyIntercomSignature({ rawBody: BODY, signatureHeader: header, clientSecret: SECRET }),
      ).toEqual({ valid: false, reason: "malformed_header" });
    }
  });

  it("never throws on adversarial header input", () => {
    for (const header of ["sha1=" + "\u0000".repeat(40), "sha1=" + "é".repeat(40), "sha1"]) {
      expect(() =>
        verifyIntercomSignature({ rawBody: BODY, signatureHeader: header, clientSecret: SECRET }),
      ).not.toThrow();
    }
  });
});

describe("readSignatureHeader", () => {
  it("prefers sha256 when both are present", () => {
    const headers: Record<string, string> = {
      "x-hub-signature": "sha1=aaa",
      "x-hub-signature-256": "sha256=bbb",
    };
    expect(readSignatureHeader((name) => headers[name])).toBe("sha256=bbb");
  });

  it("falls back to sha1", () => {
    const headers: Record<string, string> = { "x-hub-signature": "sha1=aaa" };
    expect(readSignatureHeader((name) => headers[name])).toBe("sha1=aaa");
  });

  it("returns null when neither is present", () => {
    expect(readSignatureHeader(() => undefined)).toBeNull();
  });
});
