import { describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import { createMemoryRecordStore } from "../../src/dashboard/store.js";
import {
  effectiveCategory,
  effectivePriority,
  wasCorrected,
} from "../../src/domain/triageRecord.js";
import { sampleRecord, sampleTriageResult, testDeps } from "../fixtures/deps.js";

const TOKEN = "a-sufficiently-long-token";
const EVENT_ID = "notif_created_001";

function patch(
  app: ReturnType<typeof createApp>,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(`/api/requests/${EVENT_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("effective values", () => {
  it("prefers the human correction over the model", () => {
    const record = sampleRecord({
      override: { category: "not_support", priority: "low", at: "2024-01-02T00:00:00.000Z" },
    });
    expect(effectiveCategory(record)).toBe("not_support");
    expect(effectivePriority(record)).toBe("low");
    // The model's original answer is still there to compare against.
    expect(record.result?.category).toBe("dns");
    expect(record.result?.priority).toBe("high");
  });

  it("falls back to the model when only one field was corrected", () => {
    const record = sampleRecord({ override: { priority: "low", at: "2024-01-02T00:00:00.000Z" } });
    expect(effectiveCategory(record)).toBe("dns");
    expect(effectivePriority(record)).toBe("low");
  });

  it("can classify a record the model failed on", () => {
    const record = sampleRecord({
      result: null,
      degradedReason: "timeout",
      override: { category: "billing", priority: "high", at: "2024-01-02T00:00:00.000Z" },
    });
    expect(effectiveCategory(record)).toBe("billing");
    expect(wasCorrected(record)).toBe(true);
  });

  it("does not count an override that agrees with the model as a correction", () => {
    const record = sampleRecord({
      override: { category: "dns", priority: "high", at: "2024-01-02T00:00:00.000Z" },
    });
    expect(wasCorrected(record)).toBe(false);
  });
});

describe("store.applyOverride", () => {
  it("records the correction without destroying the model's answer", () => {
    const store = createMemoryRecordStore();
    store.add(sampleRecord());

    const updated = store.applyOverride(EVENT_ID, {
      category: "not_support",
      at: "2024-01-02T00:00:00.000Z",
    });

    expect(updated?.override?.category).toBe("not_support");
    expect(updated?.result?.category).toBe("dns");
  });

  it("merges successive corrections rather than replacing them", () => {
    const store = createMemoryRecordStore();
    store.add(sampleRecord());

    store.applyOverride(EVENT_ID, { category: "billing", at: "2024-01-02T00:00:00.000Z" });
    const second = store.applyOverride(EVENT_ID, {
      priority: "low",
      at: "2024-01-03T00:00:00.000Z",
    });

    expect(second?.override).toMatchObject({ category: "billing", priority: "low" });
  });

  it("returns null for an event it no longer holds", () => {
    const store = createMemoryRecordStore();
    expect(
      store.applyOverride("gone", { category: "dns", at: "2024-01-02T00:00:00.000Z" }),
    ).toBeNull();
  });

  it("counts corrections and reports stats against the corrected values", () => {
    const store = createMemoryRecordStore();
    store.add(sampleRecord());
    expect(store.stats().byCategory).toMatchObject({ dns: 1 });

    store.applyOverride(EVENT_ID, {
      category: "not_support",
      priority: "low",
      at: "2024-01-02T00:00:00.000Z",
    });

    const stats = store.stats();
    expect(stats.corrected).toBe(1);
    expect(stats.byCategory).toMatchObject({ not_support: 1 });
    expect(stats.byCategory.dns).toBeUndefined();
    expect(stats.byPriority).toMatchObject({ low: 1, high: 0 });
  });
});

describe("PATCH /api/requests/:eventId", () => {
  function appWithRecord(overrides: Parameters<typeof testDeps>[0] = {}) {
    const deps = testDeps(overrides);
    deps.recordStore.add(sampleRecord());
    return { deps, app: createApp(deps) };
  }

  it("applies a correction and returns the updated record", async () => {
    const { app } = appWithRecord();
    const response = await patch(app, { category: "not_support", priority: "low" });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { record: { override: { category: string } } };
    expect(body.record.override.category).toBe("not_support");
  });

  it("accepts a category-only or priority-only correction", async () => {
    for (const body of [{ category: "billing" }, { priority: "critical" }]) {
      const { app } = appWithRecord();
      expect((await patch(app, body)).status, JSON.stringify(body)).toBe(200);
    }
  });

  it("stamps the correction with a timestamp", async () => {
    const deps = testDeps();
    deps.dashboard.now = () => new Date("2024-05-05T10:00:00.000Z");
    deps.recordStore.add(sampleRecord());

    const response = await patch(createApp(deps), { category: "billing" });
    const body = (await response.json()) as { record: { override: { at: string } } };

    expect(body.record.override.at).toBe("2024-05-05T10:00:00.000Z");
  });

  it("rejects an unknown category or priority", async () => {
    const { app } = appWithRecord();
    for (const body of [{ category: "made_up" }, { priority: "urgent" }]) {
      expect((await patch(app, body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it("rejects an empty correction", async () => {
    const { app } = appWithRecord();
    expect((await patch(app, {})).status).toBe(400);
  });

  it("rejects malformed JSON", async () => {
    const { app } = appWithRecord();
    const response = await app.request(`/api/requests/${EVENT_ID}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
  });

  it("returns 404 for a record that is no longer stored", async () => {
    const app = createApp(testDeps());
    const response = await app.request("/api/requests/never-seen", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ category: "dns" }),
    });
    expect(response.status).toBe(404);
  });

  it("logs the correction with labels only, never message text", async () => {
    const { deps, app } = appWithRecord();
    await patch(app, { category: "not_support", priority: "low" });

    const entry = deps.records.find((r) => r.msg === "dashboard.reclassified");
    expect(entry).toBeDefined();
    expect(entry?.fields).toMatchObject({
      fromCategory: "dns",
      toCategory: "not_support",
      fromPriority: "high",
      toPriority: "low",
    });
    expect(JSON.stringify(deps.records)).not.toContain("stopped resolving");
  });
});

describe("reclassification access control", () => {
  function tokenApp() {
    const deps = testDeps();
    deps.dashboard.token = TOKEN;
    deps.recordStore.add(sampleRecord());
    return createApp(deps);
  }

  it("rejects a write with no token when one is configured", async () => {
    expect((await patch(tokenApp(), { category: "dns" })).status).toBe(401);
  });

  it("accepts a bearer header", async () => {
    const response = await patch(
      tokenApp(),
      { category: "billing" },
      { authorization: `Bearer ${TOKEN}` },
    );
    expect(response.status).toBe(200);
  });

  it("does NOT accept the token as a query parameter for writes", async () => {
    // A URL-authenticated write could be triggered by following a link.
    const response = await tokenApp().request(`/api/requests/${EVENT_ID}?token=${TOKEN}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ category: "billing" }),
    });
    expect(response.status).toBe(401);
  });

  it("rejects a wrong bearer token", async () => {
    const response = await patch(
      tokenApp(),
      { category: "billing" },
      { authorization: "Bearer wrong" },
    );
    expect(response.status).toBe(401);
  });

  it("leaves the record untouched when a write is rejected", async () => {
    const deps = testDeps();
    deps.dashboard.token = TOKEN;
    deps.recordStore.add(sampleRecord());

    await patch(createApp(deps), { category: "abuse" });

    expect(deps.recordStore.list()[0]?.override).toBeUndefined();
    expect(deps.recordStore.list()[0]?.result?.category).toBe(sampleTriageResult.category);
  });
});
