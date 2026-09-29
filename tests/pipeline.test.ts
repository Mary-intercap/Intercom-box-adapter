import { describe, expect, it, vi } from "vitest";

import { TriageError } from "../src/domain/triage.js";
import { processSupportRequest } from "../src/pipeline.js";
import {
  capturingLogger,
  failingSink,
  failingTriage,
  recordingSink,
  sampleSupportRequest,
  sampleTriageResult,
  stubTriage,
} from "./fixtures/deps.js";

const FIXED_NOW = () => new Date("2024-03-01T12:00:00.000Z");

describe("processSupportRequest", () => {
  it("hands a classified record to the sink on the happy path", async () => {
    const sink = recordingSink();
    const { logger, records } = capturingLogger();

    await processSupportRequest(sampleSupportRequest, {
      triage: stubTriage(),
      sink,
      logger,
      now: FIXED_NOW,
    });

    expect(sink.sent).toHaveLength(1);
    expect(sink.sent[0]).toEqual({
      request: sampleSupportRequest,
      result: sampleTriageResult,
      degradedReason: null,
      processedAt: "2024-03-01T12:00:00.000Z",
    });
    expect(records.some((r) => r.msg === "triage.classified")).toBe(true);
    expect(records.some((r) => r.msg === "pipeline.notified")).toBe(true);
  });

  it("does NOT suppress records when actionRequired is false (V1 rule)", async () => {
    const sink = recordingSink();
    const { logger } = capturingLogger();

    await processSupportRequest(sampleSupportRequest, {
      triage: stubTriage({ ...sampleTriageResult, actionRequired: false, priority: "low" }),
      sink,
      logger,
    });

    expect(sink.sent).toHaveLength(1);
    expect(sink.sent[0]?.result?.actionRequired).toBe(false);
  });

  it("records a degraded entry for each triage failure reason", async () => {
    for (const reason of [
      "provider_error",
      "invalid_output",
      "refusal",
      "timeout",
      "not_configured",
    ] as const) {
      const sink = recordingSink();
      const { logger, records } = capturingLogger();

      await processSupportRequest(sampleSupportRequest, {
        triage: failingTriage(new TriageError("boom", reason)),
        sink,
        logger,
      });

      expect(sink.sent, reason).toHaveLength(1);
      expect(sink.sent[0]?.result).toBeNull();
      expect(sink.sent[0]?.degradedReason).toBe(reason);
      expect(records.find((r) => r.msg === "triage.degraded")?.fields.reason).toBe(reason);
    }
  });

  it("degrades on a plain Error from a provider too", async () => {
    const sink = recordingSink();
    const { logger } = capturingLogger();

    await processSupportRequest(sampleSupportRequest, {
      triage: failingTriage(new Error("unexpected")),
      sink,
      logger,
    });

    expect(sink.sent[0]?.result).toBeNull();
    expect(sink.sent[0]?.degradedReason).toBe("provider_error");
  });

  it("logs and swallows a sink failure instead of throwing", async () => {
    const { logger, records } = capturingLogger();

    await expect(
      processSupportRequest(sampleSupportRequest, {
        triage: stubTriage(),
        sink: failingSink(new Error("everything is down")),
        logger,
      }),
    ).resolves.toBeUndefined();

    const failure = records.find((r) => r.msg === "pipeline.notify_failed");
    expect(failure).toBeDefined();
    expect(failure?.level).toBe("error");
    expect(failure?.fields.errorMessage).toBe("everything is down");
  });

  it("never throws even when both the AI and the sink fail", async () => {
    const { logger } = capturingLogger();
    await expect(
      processSupportRequest(sampleSupportRequest, {
        triage: failingTriage(new TriageError("down", "timeout")),
        sink: failingSink(new Error("also down")),
        logger,
      }),
    ).resolves.toBeUndefined();
  });

  it("calls the classifier exactly once per request", async () => {
    const triage = stubTriage();
    const { logger } = capturingLogger();
    await processSupportRequest(sampleSupportRequest, {
      triage,
      sink: recordingSink(),
      logger,
    });
    expect(vi.mocked(triage.classify)).toHaveBeenCalledTimes(1);
  });

  it("does no formatting itself", async () => {
    // The record must be the domain shape - presentation belongs to the sinks.
    const sink = recordingSink();
    const { logger } = capturingLogger();
    await processSupportRequest(sampleSupportRequest, { triage: stubTriage(), sink, logger });

    expect(Object.keys(sink.sent[0] ?? {}).sort()).toEqual([
      "degradedReason",
      "processedAt",
      "request",
      "result",
    ]);
  });

  it("logs outcomes without the customer message body", async () => {
    const { logger, records } = capturingLogger();
    await processSupportRequest(sampleSupportRequest, {
      triage: stubTriage(),
      sink: recordingSink(),
      logger,
    });

    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain("stopped resolving this morning");
    expect(serialized).toContain("notif_created_001");
    expect(serialized).toContain('"category":"dns"');
  });
});
