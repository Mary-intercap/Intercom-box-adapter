import { describe, expect, it, vi } from "vitest";

import { TriageError } from "../src/domain/triage.js";
import { processSupportRequest } from "../src/pipeline.js";
import {
  capturingLogger,
  failingSlack,
  failingTriage,
  recordingSlack,
  sampleSupportRequest,
  sampleTriageResult,
  stubTriage,
} from "./fixtures/deps.js";

describe("processSupportRequest", () => {
  it("notifies Slack with the classification on the happy path", async () => {
    const slack = recordingSlack();
    const { logger, records } = capturingLogger();

    await processSupportRequest(sampleSupportRequest, {
      triage: stubTriage(),
      slack,
      logger,
    });

    expect(slack.sent).toHaveLength(1);
    expect(slack.sent[0]?.text).toContain("HIGH");
    expect(records.some((r) => r.msg === "triage.classified")).toBe(true);
    expect(records.some((r) => r.msg === "pipeline.notified")).toBe(true);
  });

  it("does NOT suppress notifications when actionRequired is false (V1 rule)", async () => {
    const slack = recordingSlack();
    const { logger } = capturingLogger();

    await processSupportRequest(sampleSupportRequest, {
      triage: stubTriage({ ...sampleTriageResult, actionRequired: false, priority: "low" }),
      slack,
      logger,
    });

    expect(slack.sent).toHaveLength(1);
    expect(JSON.stringify(slack.sent[0]?.blocks)).toContain("No action appears required");
  });

  it("sends a degraded notification for each triage failure reason", async () => {
    for (const reason of [
      "provider_error",
      "invalid_output",
      "refusal",
      "timeout",
      "not_configured",
    ] as const) {
      const slack = recordingSlack();
      const { logger, records } = capturingLogger();

      await processSupportRequest(sampleSupportRequest, {
        triage: failingTriage(new TriageError("boom", reason)),
        slack,
        logger,
      });

      expect(slack.sent, reason).toHaveLength(1);
      expect(slack.sent[0]?.text).toContain("UNCLASSIFIED");
      expect(records.find((r) => r.msg === "triage.degraded")?.fields.reason).toBe(reason);
    }
  });

  it("degrades on a plain Error from a provider too", async () => {
    const slack = recordingSlack();
    const { logger } = capturingLogger();

    await processSupportRequest(sampleSupportRequest, {
      triage: failingTriage(new Error("unexpected")),
      slack,
      logger,
    });

    expect(slack.sent).toHaveLength(1);
    expect(slack.sent[0]?.text).toContain("UNCLASSIFIED");
  });

  it("logs and swallows a Slack failure instead of throwing", async () => {
    const { logger, records } = capturingLogger();

    await expect(
      processSupportRequest(sampleSupportRequest, {
        triage: stubTriage(),
        slack: failingSlack(new Error("slack down")),
        logger,
      }),
    ).resolves.toBeUndefined();

    const failure = records.find((r) => r.msg === "pipeline.slack_failed");
    expect(failure).toBeDefined();
    expect(failure?.level).toBe("error");
    expect(failure?.fields.errorMessage).toBe("slack down");
  });

  it("never throws even when both the AI and Slack fail", async () => {
    const { logger } = capturingLogger();
    await expect(
      processSupportRequest(sampleSupportRequest, {
        triage: failingTriage(new TriageError("down", "timeout")),
        slack: failingSlack(new Error("also down")),
        logger,
      }),
    ).resolves.toBeUndefined();
  });

  it("calls the classifier exactly once per request", async () => {
    const triage = stubTriage();
    const { logger } = capturingLogger();
    await processSupportRequest(sampleSupportRequest, {
      triage,
      slack: recordingSlack(),
      logger,
    });
    expect(vi.mocked(triage.classify)).toHaveBeenCalledTimes(1);
  });

  it("logs outcomes without the customer message body", async () => {
    const { logger, records } = capturingLogger();
    await processSupportRequest(sampleSupportRequest, {
      triage: stubTriage(),
      slack: recordingSlack(),
      logger,
    });

    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain("stopped resolving this morning");
    expect(serialized).toContain("notif_created_001");
    expect(serialized).toContain('"category":"dns"');
  });
});
