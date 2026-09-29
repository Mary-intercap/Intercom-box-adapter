import { describe, expect, it } from "vitest";

import { createMemoryRecordStore } from "../../src/dashboard/store.js";
import { sampleRecord, sampleTriageResult } from "../fixtures/deps.js";

function record(id: string, overrides: Parameters<typeof sampleRecord>[0] = {}) {
  const base = sampleRecord(overrides);
  return { ...base, request: { ...base.request, eventId: id } };
}

describe("memory record store", () => {
  it("starts empty", () => {
    const store = createMemoryRecordStore();
    expect(store.list()).toEqual([]);
    expect(store.size()).toBe(0);
    expect(store.stats().total).toBe(0);
  });

  it("returns records newest first", () => {
    const store = createMemoryRecordStore();
    store.add(record("a"));
    store.add(record("b"));
    store.add(record("c"));

    expect(store.list().map((r) => r.request.eventId)).toEqual(["c", "b", "a"]);
  });

  it("honours a limit", () => {
    const store = createMemoryRecordStore();
    for (const id of ["a", "b", "c", "d"]) store.add(record(id));

    expect(store.list({ limit: 2 }).map((r) => r.request.eventId)).toEqual(["d", "c"]);
    expect(store.list({ limit: 0 })).toEqual([]);
  });

  it("evicts the oldest records past the cap", () => {
    const store = createMemoryRecordStore({ maxRecords: 3 });
    for (const id of ["a", "b", "c", "d", "e"]) store.add(record(id));

    expect(store.size()).toBe(3);
    expect(store.list().map((r) => r.request.eventId)).toEqual(["e", "d", "c"]);
  });

  it("does not hand out a mutable view of its own array", () => {
    const store = createMemoryRecordStore();
    store.add(record("a"));
    store.list().pop();
    expect(store.size()).toBe(1);
  });

  it("counts classified, degraded and action-required records", () => {
    const store = createMemoryRecordStore();
    store.add(record("a"));
    store.add(
      record("b", { result: { ...sampleTriageResult, actionRequired: false, priority: "low" } }),
    );
    store.add(record("c", { result: null, degradedReason: "timeout" }));

    const stats = store.stats();
    expect(stats).toMatchObject({
      total: 3,
      classified: 2,
      degraded: 1,
      actionRequired: 1,
    });
  });

  it("breaks counts down by priority and category", () => {
    const store = createMemoryRecordStore();
    store.add(
      record("a", {
        result: { ...sampleTriageResult, priority: "critical", category: "security" },
      }),
    );
    store.add(
      record("b", { result: { ...sampleTriageResult, priority: "critical", category: "dns" } }),
    );
    store.add(record("c", { result: { ...sampleTriageResult, priority: "low", category: "dns" } }));

    const stats = store.stats();
    expect(stats.byPriority).toEqual({ low: 1, medium: 0, high: 0, critical: 2 });
    expect(stats.byCategory).toEqual({ dns: 2, security: 1 });
  });

  it("excludes degraded records from priority and category counts", () => {
    const store = createMemoryRecordStore();
    store.add(record("a", { result: null, degradedReason: "provider_error" }));

    const stats = store.stats();
    expect(stats.byPriority).toEqual({ low: 0, medium: 0, high: 0, critical: 0 });
    expect(stats.byCategory).toEqual({});
    expect(stats.degraded).toBe(1);
  });
});
