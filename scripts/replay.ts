/**
 * Replay a captured Intercom payload against a running instance, signed the
 * way Intercom signs it.
 *
 *   npm run replay -- path/to/payload.json [url]
 *
 * Reads INTERCOM_CLIENT_SECRET from the environment (or a local .env line).
 * Default target: http://localhost:3000/webhooks/intercom
 *
 * Unlike `inspect`, this exercises the real service: signature verification,
 * idempotency, the AI call, and a real Slack post. Point it at a local instance,
 * not production.
 */
import { readFileSync } from "node:fs";

import { signPayload } from "../src/intercom/verifySignature.js";

function fail(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function readSecret(): string {
  const fromEnv = process.env.INTERCOM_CLIENT_SECRET;
  if (fromEnv && fromEnv.trim() !== "") return fromEnv.trim();

  // Convenience: pull it straight out of .env so this works without `source`.
  try {
    const line = readFileSync(".env", "utf8")
      .split("\n")
      .find((l) => l.trim().startsWith("INTERCOM_CLIENT_SECRET="));
    const value = line
      ?.slice(line.indexOf("=") + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (value) return value;
  } catch {
    // .env is optional.
  }
  return fail("INTERCOM_CLIENT_SECRET is not set (in the environment or in .env)");
}

const path = process.argv[2];
if (!path) fail("usage: npm run replay -- path/to/payload.json [url]");

const url = process.argv[3] ?? "http://localhost:3000/webhooks/intercom";

let body: string;
try {
  // Re-serialise once here so the bytes we sign are exactly the bytes we send.
  body = JSON.stringify(JSON.parse(readFileSync(path, "utf8")));
} catch (error) {
  fail(
    `could not read or parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

const signature = signPayload(body, readSecret());

console.log(`POST ${url}`);
console.log(`  ${body.length} bytes, x-hub-signature: ${signature.slice(0, 13)}…\n`);

const response = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json", "x-hub-signature": signature },
  body,
}).catch((error: unknown) =>
  fail(`request failed: ${error instanceof Error ? error.message : String(error)}`),
);

const text = await response.text();
console.log(`← HTTP ${response.status}\n  ${text}\n`);

if (response.status === 202) {
  console.log("✓ Accepted. Watch the service logs for triage.classified and pipeline.notified.\n");
} else if (response.status === 401) {
  console.log(
    "✗ Signature rejected - the secret here does not match the one the service loaded.\n",
  );
} else if (response.status === 200) {
  console.log("○ Acknowledged but not processed (duplicate, ignored topic, or no message).\n");
}
