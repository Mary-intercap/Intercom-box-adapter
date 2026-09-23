import { describe, expect, it } from "vitest";

import { createLogger, errorInfo } from "../../src/utils/logger.js";

function collecting(level: "debug" | "info" | "warn" | "error" = "info") {
  const records: Record<string, unknown>[] = [];
  const logger = createLogger({
    level,
    write: (_level, record) => records.push(record),
    now: () => new Date("2024-01-01T00:00:00.000Z"),
  });
  return { logger, records };
}

describe("logger", () => {
  it("emits structured records with a timestamp and level", () => {
    const { logger, records } = collecting();
    logger.info("webhook.accepted", { eventId: "evt_1" });
    expect(records[0]).toEqual({
      time: "2024-01-01T00:00:00.000Z",
      level: "info",
      msg: "webhook.accepted",
      eventId: "evt_1",
    });
  });

  it("filters records below the configured level", () => {
    const { logger, records } = collecting("warn");
    logger.debug("a");
    logger.info("b");
    logger.warn("c");
    logger.error("d");
    expect(records.map((r) => r.msg)).toEqual(["c", "d"]);
  });

  it("merges child bindings", () => {
    const { logger, records } = collecting();
    logger.child({ eventId: "evt_1" }).child({ topic: "x" }).info("hit", { extra: 1 });
    expect(records[0]).toMatchObject({ eventId: "evt_1", topic: "x", extra: 1 });
  });

  it("redacts secret-looking field names at any depth", () => {
    const { logger, records } = collecting();
    logger.info("startup", {
      clientSecret: "abc",
      access_token: "def",
      apiKey: "ghi",
      webhookUrl: "https://hooks.slack.com/services/x",
      authorization: "Bearer zzz",
      nested: { intercomClientSecret: "jkl", safe: "visible" },
    });

    const serialized = JSON.stringify(records[0]);
    for (const secret of ["abc", "def", "ghi", "jkl", "zzz", "hooks.slack.com"]) {
      expect(serialized, secret).not.toContain(secret);
    }
    expect(serialized).toContain("visible");
  });

  it("serialises errors without stacks or causes", () => {
    const { logger, records } = collecting();
    const error = new Error("boom");
    (error as Error & { cause?: unknown }).cause = { requestBody: "sensitive" };
    logger.error("failed", { error });

    const serialized = JSON.stringify(records[0]);
    expect(serialized).toContain("boom");
    expect(serialized).not.toContain("sensitive");
    expect(serialized).not.toContain("at Object");
  });

  it("truncates very long string fields", () => {
    const { logger, records } = collecting();
    logger.info("long", { blob: "x".repeat(5000) });
    expect(String(records[0]?.blob)).toHaveLength(2000 + "...[truncated]".length);
  });
});

describe("errorInfo", () => {
  it("extracts name and message from an Error", () => {
    expect(errorInfo(new TypeError("bad"))).toEqual({
      errorName: "TypeError",
      errorMessage: "bad",
    });
  });

  it("handles non-Error throws", () => {
    expect(errorInfo("just a string")).toEqual({
      errorName: "UnknownError",
      errorMessage: "just a string",
    });
  });
});
