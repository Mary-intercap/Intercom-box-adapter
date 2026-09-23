import type { Context } from "hono";

import { claimEvent, type EventStore } from "../domain/eventStore.js";
import { processSupportRequest, type PipelineDeps } from "../pipeline.js";
import type { Defer } from "../runtime.js";
import { errorInfo, type Logger } from "../utils/logger.js";
import { parseIntercomEvent } from "./parseEvent.js";
import { toSupportRequest } from "./toSupportRequest.js";
import { readSignatureHeader, verifyIntercomSignature } from "./verifySignature.js";

/**
 * POST /webhooks/intercom
 *
 * Order matters and is enforced here:
 *   1. read the RAW body
 *   2. verify the signature over those exact bytes
 *   3. only then parse JSON
 *   4. validate the envelope
 *   5. filter by topic
 *   6. claim the event id (idempotency)
 *   7. respond
 *   8. classify and notify, after responding
 *
 * ## Response codes and why
 *
 * Intercom retries a failed delivery once, ~1 minute later, and backs off for
 * ~15 minutes if an endpoint errors repeatedly. The status codes below are
 * chosen so a retry only ever happens when a retry could actually help.
 *
 *   401 invalid/missing signature  - never valid; retrying changes nothing
 *   400 unparseable body           - the bytes are broken; retrying changes nothing
 *   200 unsupported topic          - deliberate no-op
 *   200 duplicate event            - already claimed
 *   200 no customer message        - nothing to triage (bot echo, empty body)
 *   202 accepted                   - queued for processing
 *
 * Downstream failures (AI, Slack) happen AFTER the response and never turn into
 * a 5xx. Returning 500 there would earn a retry that produces a second AI call
 * and a second Slack alert for the same customer message - strictly worse than
 * one logged failure. The cost of this choice is explicit: a Slack outage means
 * lost notifications, not delayed ones. See README > Error handling.
 */

export interface WebhookDeps extends PipelineDeps {
  clientSecret: string;
  eventStore: EventStore;
  defer: Defer;
}

const MAX_BODY_BYTES = 1_000_000;

export function createIntercomWebhookHandler(deps: WebhookDeps) {
  return async function handleIntercomWebhook(c: Context): Promise<Response> {
    const log: Logger = deps.logger;

    // 1. Raw bytes. Anything that re-serialises the body breaks the HMAC.
    let rawBody: Buffer;
    try {
      rawBody = Buffer.from(await c.req.arrayBuffer());
    } catch (error) {
      log.warn("webhook.body_read_failed", errorInfo(error));
      return c.json({ error: "invalid_request" }, 400);
    }

    if (rawBody.byteLength > MAX_BODY_BYTES) {
      log.warn("webhook.body_too_large", { bytes: rawBody.byteLength });
      return c.json({ error: "payload_too_large" }, 413);
    }

    // 2. Verify before trusting a single byte of it.
    const verification = verifyIntercomSignature({
      rawBody,
      signatureHeader: readSignatureHeader((name) => c.req.header(name)),
      clientSecret: deps.clientSecret,
    });

    if (!verification.valid) {
      log.warn("webhook.signature_rejected", { reason: verification.reason });
      // Generic to the caller; the reason stays in our logs.
      return c.json({ error: "invalid_signature" }, 401);
    }

    // 3. Parse only now.
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      log.warn("webhook.malformed_json", { bytes: rawBody.byteLength });
      return c.json({ error: "invalid_payload" }, 400);
    }

    // 4 + 5. Validate the envelope and filter by topic.
    const parsed = parseIntercomEvent(payload);
    if (parsed.kind === "invalid") {
      log.warn("webhook.invalid_envelope", { detail: parsed.detail });
      return c.json({ error: "invalid_payload" }, 400);
    }
    if (parsed.kind === "ignored") {
      log.info("webhook.ignored", { topic: parsed.topic, reason: parsed.reason });
      return c.json({ status: "ignored", reason: parsed.reason }, 200);
    }

    const { notification, topic } = parsed;
    const eventLog = log.child({ eventId: notification.id, topic });

    // 6. Claim before doing any work, so Intercom's retry is a no-op.
    let claimed: boolean;
    try {
      claimed = await claimEvent(deps.eventStore, notification.id);
    } catch (error) {
      // A store failure must not lose the event: proceed and risk a duplicate
      // rather than dropping a customer request.
      eventLog.error("webhook.event_store_failed", errorInfo(error));
      claimed = true;
    }
    if (!claimed) {
      eventLog.info("webhook.duplicate");
      return c.json({ status: "duplicate" }, 200);
    }

    // 7. Normalize. A payload we cannot read is acknowledged, not retried.
    const normalized = toSupportRequest(notification, topic);
    if (normalized.kind === "skipped") {
      eventLog.info("webhook.skipped", { reason: normalized.reason });
      return c.json({ status: "skipped", reason: normalized.reason }, 200);
    }

    const request = normalized.request;
    eventLog.info("webhook.accepted", { conversationId: request.conversationId });
    // Opt-in only: message bodies are customer data.
    eventLog.debug("webhook.accepted_detail", {
      conversationId: request.conversationId,
      messageLength: request.message.length,
      message: request.message,
    });

    // 8. Acknowledge, then process.
    await deps.defer(() =>
      processSupportRequest(request, {
        triage: deps.triage,
        slack: deps.slack,
        logger: deps.logger,
      }),
    );

    return c.json({ status: "accepted", eventId: request.eventId }, 202);
  };
}
