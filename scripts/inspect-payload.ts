/**
 * Dry-run a real Intercom webhook payload through the adapter.
 *
 *   npm run inspect -- path/to/payload.json
 *
 * Makes no network calls, needs no credentials, and calls no AI provider. It
 * answers one question: given this exact payload, what would the service
 * extract, what would the model be shown, and what would Slack receive?
 *
 * Use it to validate the parser against payloads from a real workspace - the
 * conversation shape inside `data.item` is not fully published by Intercom.
 *
 * NOTE: the output contains the customer's message verbatim. Treat whatever you
 * paste in, and whatever this prints, as customer data.
 */
import { readFileSync } from "node:fs";

import { parseIntercomEvent } from "../src/intercom/parseEvent.js";
import { toSupportRequest } from "../src/intercom/toSupportRequest.js";
import { buildTriageMessage } from "../src/notifications/formatting.js";
import { buildUserPrompt } from "../src/triage/prompt.js";
import type { TriageResult } from "../src/triage/schema.js";

const PLACEHOLDER_RESULT: TriageResult = {
  category: "dns",
  priority: "high",
  actionRequired: true,
  confidence: 0.9,
  summary: "<<< the model's summary would appear here >>>",
  suggestedResponse: "<<< the model's suggested reply would appear here >>>",
  reasoningSummary: "<<< the model's reasoning summary would appear here >>>",
};

function heading(title: string): void {
  console.log(`\n${"─".repeat(72)}\n${title}\n${"─".repeat(72)}`);
}

function fail(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

const path = process.argv[2];
if (!path) fail("usage: npm run inspect -- path/to/payload.json");

let payload: unknown;
try {
  payload = JSON.parse(readFileSync(path, "utf8"));
} catch (error) {
  fail(
    `could not read or parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

heading("1. Envelope");
const parsed = parseIntercomEvent(payload);

if (parsed.kind === "invalid") {
  console.log(`✗ REJECTED (HTTP 400) - not a valid notification envelope`);
  console.log(`  ${parsed.detail}`);
  console.log(`\n  The service requires at least: id, topic, data.item`);
  process.exit(1);
}
if (parsed.kind === "ignored") {
  console.log(`○ IGNORED (HTTP 200) - topic "${parsed.topic}" is not subscribed`);
  console.log(`  Supported: conversation.user.created, conversation.user.replied`);
  process.exit(0);
}

console.log(`✓ ACCEPTED`);
console.log(`  topic:    ${parsed.topic}`);
console.log(`  event id: ${parsed.notification.id}`);
console.log(
  `  app id:   ${parsed.notification.app_id ?? "(absent - no Intercom link will be built)"}`,
);

heading("2. Normalized SupportRequest");
const normalized = toSupportRequest(parsed.notification, parsed.topic);

if (normalized.kind === "skipped") {
  console.log(`○ SKIPPED (HTTP 200) - reason: ${normalized.reason}`);
  console.log(
    normalized.reason === "no_customer_message"
      ? "\n  No customer-authored text was found. For a reply this means no\n" +
          "  conversation_part had an author type of user/lead/contact/visitor\n" +
          "  with a non-empty body."
      : "\n  data.item could not be read as a conversation (missing id, or not an object).",
  );
  console.log(
    `\n  ⚠ If this payload SHOULD have produced a notification, the parser\n    needs adjusting. That is exactly what this script is for.`,
  );
  process.exit(1);
}

const request = normalized.request;
console.log(JSON.stringify(request, null, 2));

const warnings: string[] = [];
if (!request.customer)
  warnings.push("no customer identity found - Slack will show '_unidentified_'");
if (!request.customer?.email && !request.customer?.name)
  warnings.push("customer has an id but no email or name - Slack will show the raw id");
if (!request.intercomUrl)
  warnings.push("no Intercom link - app_id was missing or not a plain identifier");
if (!request.createdAt) warnings.push("no timestamp could be derived");
if (!request.messageId) warnings.push("no message id could be derived");

if (warnings.length > 0) {
  console.log("\n  Warnings:");
  for (const warning of warnings) console.log(`    ⚠ ${warning}`);
}

heading("3. What the model would be sent (user turn)");
console.log(buildUserPrompt(request));

heading("4. What Slack would receive");
const message = buildTriageMessage(request, PLACEHOLDER_RESULT);
console.log(`fallback text: ${message.text}\n`);
console.log(JSON.stringify(message.blocks, null, 2));

heading("Result");
console.log("✓ This payload would produce a Slack notification (HTTP 202).");
console.log("  Category/priority/summary above are placeholders - no AI call was made.\n");
