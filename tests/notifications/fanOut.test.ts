import { describe, expect, it } from "vitest";

import { createFanOutSink } from "../../src/notifications/fanOut.js";
import { createSlackSink } from "../../src/notifications/slackSink.js";
import {
  capturingLogger,
  failingSink,
  recordingSink,
  recordingSlack,
  sampleRecord,
} from "../fixtures/deps.js";

describe("fan-out sink", () => {
  it("delivers to every sink", async () => {
    const a = recordingSink("a");
    const b = recordingSink("b");
    const { logger } = capturingLogger();

    await createFanOutSink([a, b], logger).notify(sampleRecord());

    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
  });

  it("isolates a failing sink so the others still receive the record", async () => {
    const healthy = recordingSink("dashboard");
    const { logger, records } = capturingLogger();

    await createFanOutSink([failingSink(new Error("slack down"), "slack"), healthy], logger).notify(
      sampleRecord(),
    );

    expect(healthy.sent).toHaveLength(1);
    const failure = records.find((r) => r.msg === "sink.failed");
    expect(failure?.fields.sink).toBe("slack");
    expect(failure?.fields.errorMessage).toBe("slack down");
  });

  it("throws only when every sink fails", async () => {
    const { logger } = capturingLogger();

    await expect(
      createFanOutSink(
        [failingSink(new Error("a"), "a"), failingSink(new Error("b"), "b")],
        logger,
      ).notify(sampleRecord()),
    ).rejects.toThrow(/all 2 notification sinks failed/);
  });

  it("is a no-op with no sinks configured", async () => {
    const { logger } = capturingLogger();
    await expect(createFanOutSink([], logger).notify(sampleRecord())).resolves.toBeUndefined();
  });

  it("names itself after its members, for logging", () => {
    const { logger } = capturingLogger();
    expect(
      createFanOutSink([recordingSink("dashboard"), recordingSink("slack")], logger).name,
    ).toBe("dashboard+slack");
  });
});

describe("slack sink", () => {
  it("formats a classified record as a triage message", async () => {
    const slack = recordingSlack();
    await createSlackSink(slack).notify(sampleRecord());

    expect(slack.sent).toHaveLength(1);
    expect(slack.sent[0]?.text).toContain("HIGH");
    expect(JSON.stringify(slack.sent[0]?.blocks)).toContain("AI summary");
  });

  it("formats a degraded record as an unclassified message", async () => {
    const slack = recordingSlack();
    await createSlackSink(slack).notify(sampleRecord({ result: null, degradedReason: "timeout" }));

    expect(slack.sent[0]?.text).toContain("UNCLASSIFIED");
    expect(JSON.stringify(slack.sent[0]?.blocks)).toContain("The AI request timed out.");
  });

  it("propagates a Slack failure so the fan-out can log it", async () => {
    const boom = new Error("slack 500");
    await expect(
      createSlackSink({ notify: () => Promise.reject(boom) }).notify(sampleRecord()),
    ).rejects.toBe(boom);
  });
});
