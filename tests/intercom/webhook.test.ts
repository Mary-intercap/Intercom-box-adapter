import { describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import { TriageError } from "../../src/domain/triage.js";
import { signPayload } from "../../src/intercom/verifySignature.js";
import { failingSlack, failingTriage, testDeps } from "../fixtures/deps.js";
import {
  conversationCreatedPayload,
  conversationRepliedPayload,
  signedRequest,
  TEST_CLIENT_SECRET,
  unsupportedTopicPayload,
} from "../fixtures/intercom.js";

function post(app: ReturnType<typeof createApp>, body: string, headers: Record<string, string>) {
  return app.request("/webhooks/intercom", { method: "POST", body, headers });
}

describe("GET /health", () => {
  it("returns ok", async () => {
    const app = createApp(testDeps());
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });
});

describe("POST /webhooks/intercom", () => {
  it("accepts a validly signed event and notifies Slack", async () => {
    const deps = testDeps();
    const { body, headers } = signedRequest(conversationCreatedPayload());

    const response = await post(createApp(deps), body, headers);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      status: "accepted",
      eventId: "notif_created_001",
    });
    expect(deps.slackRecorder.sent).toHaveLength(1);
    expect(deps.slackRecorder.sent[0]?.text).toContain("HIGH");
  });

  it("accepts a sha256 signature", async () => {
    const deps = testDeps();
    const body = JSON.stringify(conversationRepliedPayload());
    const response = await post(createApp(deps), body, {
      "content-type": "application/json",
      "x-hub-signature-256": signPayload(body, TEST_CLIENT_SECRET, "sha256"),
    });
    expect(response.status).toBe(202);
  });

  it("rejects an invalid signature with 401 and does no downstream work", async () => {
    const deps = testDeps();
    const body = JSON.stringify(conversationCreatedPayload());

    const response = await post(createApp(deps), body, {
      "content-type": "application/json",
      "x-hub-signature": signPayload(body, "attacker-secret"),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "invalid_signature" });
    expect(deps.slackRecorder.sent).toHaveLength(0);
  });

  it("rejects a missing signature with 401", async () => {
    const deps = testDeps();
    const response = await post(createApp(deps), JSON.stringify(conversationCreatedPayload()), {
      "content-type": "application/json",
    });
    expect(response.status).toBe(401);
    expect(deps.slackRecorder.sent).toHaveLength(0);
  });

  it("does not leak the rejection reason to the caller", async () => {
    const deps = testDeps();
    const response = await post(createApp(deps), "{}", {
      "content-type": "application/json",
      "x-hub-signature": "sha1=" + "0".repeat(40),
    });
    const payload: unknown = await response.json();
    expect(payload).toEqual({ error: "invalid_signature" });
    // The detail is in our logs, not in the response.
    expect(deps.records.some((r) => r.msg === "webhook.signature_rejected")).toBe(true);
  });

  it("returns 400 for malformed JSON that is correctly signed", async () => {
    const deps = testDeps();
    const { body, headers } = signedRequest("{not json at all");

    const response = await post(createApp(deps), body, headers);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_payload" });
    expect(deps.slackRecorder.sent).toHaveLength(0);
  });

  it("returns 400 for a signed payload that is not a notification envelope", async () => {
    const deps = testDeps();
    const { body, headers } = signedRequest({ hello: "world" });
    const response = await post(createApp(deps), body, headers);
    expect(response.status).toBe(400);
    expect(deps.slackRecorder.sent).toHaveLength(0);
  });

  it("acknowledges unsupported topics with 200 and no work", async () => {
    const deps = testDeps();
    const { body, headers } = signedRequest(unsupportedTopicPayload());

    const response = await post(createApp(deps), body, headers);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ignored",
      reason: "unsupported_topic",
    });
    expect(deps.slackRecorder.sent).toHaveLength(0);
  });

  it("processes a duplicate event exactly once", async () => {
    const deps = testDeps();
    const app = createApp(deps);
    const { body, headers } = signedRequest(conversationCreatedPayload());

    const first = await post(app, body, headers);
    const second = await post(app, body, headers);

    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual({ status: "duplicate" });
    expect(deps.slackRecorder.sent).toHaveLength(1);
  });

  it("deduplicates concurrent deliveries of the same event", async () => {
    const deps = testDeps();
    const app = createApp(deps);
    const { body, headers } = signedRequest(conversationCreatedPayload());

    const responses = await Promise.all([
      post(app, body, headers),
      post(app, body, headers),
      post(app, body, headers),
    ]);

    expect(responses.filter((r) => r.status === 202)).toHaveLength(1);
    expect(deps.slackRecorder.sent).toHaveLength(1);
  });

  it("acknowledges an event with no customer message without notifying", async () => {
    const payload = conversationCreatedPayload();
    const item = (payload.data as { item: Record<string, unknown> }).item;
    (item.source as Record<string, unknown>).body = "";
    const deps = testDeps();
    const { body, headers } = signedRequest(payload);

    const response = await post(createApp(deps), body, headers);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "skipped" });
    expect(deps.slackRecorder.sent).toHaveLength(0);
  });

  it("still returns 202 when the AI provider fails, and sends a degraded alert", async () => {
    const deps = testDeps({
      triage: failingTriage(new TriageError("upstream 503", "provider_error")),
    });
    const { body, headers } = signedRequest(conversationCreatedPayload());

    const response = await post(createApp(deps), body, headers);

    // Never a 500: a 500 would earn an Intercom retry and a duplicate alert.
    expect(response.status).toBe(202);
    expect(deps.slackRecorder.sent).toHaveLength(1);
    expect(deps.slackRecorder.sent[0]?.text).toContain("UNCLASSIFIED");
  });

  it("still returns 202 when Slack fails", async () => {
    const deps = testDeps({ slack: failingSlack(new Error("slack down")) });
    const { body, headers } = signedRequest(conversationCreatedPayload());

    const response = await post(createApp(deps), body, headers);

    expect(response.status).toBe(202);
    expect(deps.records.some((r) => r.msg === "pipeline.slack_failed")).toBe(true);
  });

  it("returns 413 for an oversized body before verifying anything", async () => {
    const deps = testDeps();
    const huge = "x".repeat(1_000_001);
    const response = await post(createApp(deps), huge, { "content-type": "application/json" });
    expect(response.status).toBe(413);
  });

  it("returns 404 for unknown routes", async () => {
    const response = await createApp(testDeps()).request("/nope");
    expect(response.status).toBe(404);
  });
});

describe("logging privacy", () => {
  it("does not log the customer message at info level", async () => {
    const deps = testDeps();
    const { body, headers } = signedRequest(conversationCreatedPayload());
    await post(createApp(deps), body, headers);

    const nonDebug = deps.records.filter((r) => r.level !== "debug");
    const serialized = JSON.stringify(nonDebug);
    expect(serialized).not.toContain("stopped resolving");
    expect(serialized).not.toContain("customer@example.com");
    // Identifiers are present, which is the point.
    expect(serialized).toContain("notif_created_001");
    expect(serialized).toContain("conv_5001");
  });

  it("never logs the client secret", async () => {
    const deps = testDeps();
    const { body, headers } = signedRequest(conversationCreatedPayload());
    await post(createApp(deps), body, headers);
    expect(JSON.stringify(deps.records)).not.toContain(TEST_CLIENT_SECRET);
  });
});
