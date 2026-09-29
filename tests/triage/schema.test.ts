import { describe, expect, it } from "vitest";

import {
  modelOutputSchema,
  toTriageResult,
  TRIAGE_CATEGORIES,
  TRIAGE_PRIORITIES,
} from "../../src/triage/schema.js";

const validOutput = {
  category: "dns",
  priority: "high",
  actionRequired: true,
  confidence: 0.92,
  summary: "Customer reports their domain stopped resolving.",
  suggestedResponse: "Thanks for reporting this. We'll take a look at the DNS status.",
  reasoningSummary: "Loss of resolution on a paid domain.",
};

describe("triage result validation", () => {
  it("accepts a well-formed model output", () => {
    expect(toTriageResult(validOutput)).toEqual(validOutput);
  });

  it("treats a null reasoningSummary as absent", () => {
    const result = toTriageResult({ ...validOutput, reasoningSummary: null });
    expect(result.reasoningSummary).toBeUndefined();
    expect("reasoningSummary" in result).toBe(false);
  });

  it("treats an empty reasoningSummary as absent", () => {
    expect(
      toTriageResult({ ...validOutput, reasoningSummary: "" }).reasoningSummary,
    ).toBeUndefined();
  });

  it("clamps out-of-range confidence rather than dropping the notification", () => {
    expect(toTriageResult({ ...validOutput, confidence: 1.4 }).confidence).toBe(1);
    expect(toTriageResult({ ...validOutput, confidence: -3 }).confidence).toBe(0);
  });

  it("rejects an unknown category", () => {
    expect(() => toTriageResult({ ...validOutput, category: "dns_stuff" })).toThrow();
  });

  it("rejects an unknown priority", () => {
    expect(() => toTriageResult({ ...validOutput, priority: "urgent" })).toThrow();
  });

  it("rejects a non-boolean actionRequired", () => {
    expect(() => toTriageResult({ ...validOutput, actionRequired: "yes" })).toThrow();
  });

  it("rejects a non-numeric confidence", () => {
    expect(() => toTriageResult({ ...validOutput, confidence: "high" })).toThrow();
  });

  it("rejects missing required fields", () => {
    for (const key of [
      "category",
      "priority",
      "actionRequired",
      "confidence",
      "summary",
      "suggestedResponse",
    ]) {
      const partial: Record<string, unknown> = { ...validOutput };
      delete partial[key];
      expect(() => toTriageResult(partial), `missing ${key}`).toThrow();
    }
  });

  it("rejects an empty summary or suggested response", () => {
    expect(() => toTriageResult({ ...validOutput, summary: "" })).toThrow();
    expect(() => toTriageResult({ ...validOutput, suggestedResponse: "" })).toThrow();
  });

  it("rejects null and non-object input", () => {
    for (const input of [null, undefined, "text", 5, []]) {
      expect(() => toTriageResult(input)).toThrow();
    }
  });

  it("accepts every declared category and priority", () => {
    for (const category of TRIAGE_CATEGORIES) {
      for (const priority of TRIAGE_PRIORITIES) {
        expect(() => toTriageResult({ ...validOutput, category, priority })).not.toThrow();
      }
    }
  });

  it("accepts the non-support categories", () => {
    for (const category of ["not_support", "misdirected"] as const) {
      expect(() => toTriageResult({ ...validOutput, category, priority: "low" })).not.toThrow();
    }
    expect(TRIAGE_CATEGORIES).toContain("not_support");
    expect(TRIAGE_CATEGORIES).toContain("misdirected");
  });

  it("keeps the model-facing schema free of unsupported refinements", () => {
    // The model schema must stay plain; bounds belong in triageResultSchema.
    const parsed = modelOutputSchema.safeParse({ ...validOutput, confidence: 4 });
    expect(parsed.success).toBe(true);
  });
});
