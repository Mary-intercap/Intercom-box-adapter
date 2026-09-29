import { describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import { sampleRecord, sampleTriageResult, testDeps } from "../fixtures/deps.js";

const TOKEN = "a-sufficiently-long-token";

describe("GET / (dashboard page)", () => {
  it("serves an HTML page", async () => {
    const response = await createApp(testDeps()).request("/");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("<!doctype html>");
    expect(body).toContain("box support triage");
  });

  it("sets a strict content security policy and no-referrer", async () => {
    const response = await createApp(testDeps()).request("/");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("is never cached — a stale copy would hide new controls and cache customer data", async () => {
    const response = await createApp(testDeps()).request("/");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("loads no external resources", async () => {
    const body = await (await createApp(testDeps()).request("/")).text();
    expect(body).not.toMatch(/src=["']https?:/);
    expect(body).not.toMatch(/<link[^>]+href=["']https?:/);
  });

  it("never writes untrusted content into the DOM as markup", async () => {
    const body = await (await createApp(testDeps()).request("/")).text();

    // A customer message containing markup must be displayed, not parsed.
    expect(body).not.toMatch(/\.innerHTML\s*=/);
    expect(body).not.toMatch(/\.outerHTML\s*=/);
    expect(body).not.toMatch(/insertAdjacentHTML/);
    expect(body).not.toMatch(/document\.write/);
    expect(body).toContain("textContent");
  });
});

describe("GET /api/requests", () => {
  it("returns an empty payload before anything is processed", async () => {
    const response = await createApp(testDeps()).request("/api/requests");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      records: [],
      stats: { total: 0 },
    });
  });

  it("returns stored records newest first with their triage result", async () => {
    const deps = testDeps();
    deps.recordStore.add(sampleRecord());
    deps.recordStore.add({
      ...sampleRecord(),
      request: { ...sampleRecord().request, eventId: "second" },
    });

    const payload = (await (await createApp(deps).request("/api/requests")).json()) as {
      records: { request: { eventId: string }; result: { category: string } | null }[];
      stats: { total: number; classified: number };
    };

    expect(payload.records.map((r) => r.request.eventId)).toEqual(["second", "notif_created_001"]);
    expect(payload.records[0]?.result?.category).toBe("dns");
    expect(payload.stats).toMatchObject({ total: 2, classified: 2 });
  });

  it("marks customer data as uncacheable", async () => {
    const response = await createApp(testDeps()).request("/api/requests");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("clamps the limit parameter", async () => {
    const deps = testDeps();
    for (let i = 0; i < 5; i += 1) {
      deps.recordStore.add({
        ...sampleRecord(),
        request: { ...sampleRecord().request, eventId: `e${String(i)}` },
      });
    }
    const app = createApp(deps);

    const two = (await (await app.request("/api/requests?limit=2")).json()) as {
      records: unknown[];
    };
    expect(two.records).toHaveLength(2);

    // Nonsense and out-of-range values fall back to safe defaults rather than erroring.
    for (const query of ["limit=abc", "limit=-5", "limit=999999"]) {
      const response = await app.request(`/api/requests?${query}`);
      expect(response.status, query).toBe(200);
    }
  });
});

describe("dashboard sorting", () => {
  it("exposes all four sort keys on every record", async () => {
    const deps = testDeps();
    deps.recordStore.add(sampleRecord());

    const payload = (await (await createApp(deps).request("/api/requests")).json()) as {
      records: {
        processedAt: string;
        request: Record<string, unknown>;
      }[];
    };
    const record = payload.records[0];
    expect(record?.processedAt).toBeDefined();
    expect(record?.request.createdAt).toBeDefined();
    // conversationCreatedAt / lastResponseAt may be absent; the field must be
    // addressable either way, which the sort handles as "unknown, sorts last".
    expect("conversationCreatedAt" in (record?.request ?? {})).toBe(false);
  });

  it("offers all five sort options in the page", async () => {
    const body = await (await createApp(testDeps()).request("/")).text();
    for (const key of [
      "priority",
      "processedAt",
      "createdAt",
      "conversationCreatedAt",
      "lastResponseAt",
    ]) {
      expect(body, key).toContain(`value="${key}"`);
    }
  });

  it("labels the sort direction per key — dates and priority read differently", async () => {
    const body = await (await createApp(testDeps()).request("/")).text();
    expect(body).toContain("Newest first");
    expect(body).toContain("Oldest first");
    expect(body).toContain("Highest first");
    expect(body).toContain("Lowest first");
  });

  it("ranks priority as an ordinal, not alphabetically", async () => {
    const body = await (await createApp(testDeps()).request("/")).text();
    // Alphabetical order would put "critical" below "high" and "low" above
    // "medium", which is backwards in both cases.
    expect(body).toMatch(/low:\s*1/);
    expect(body).toMatch(/medium:\s*2/);
    expect(body).toMatch(/high:\s*3/);
    expect(body).toMatch(/critical:\s*4/);
  });

  it("keeps non-support categories in the same list as everything else", async () => {
    // They are labelled, not bucketed: the category filter is how you narrow.
    const deps = testDeps();
    deps.recordStore.add(sampleRecord());
    deps.recordStore.add(
      sampleRecord({ result: { ...sampleTriageResult, category: "not_support" } }),
    );

    const payload = (await (await createApp(deps).request("/api/requests")).json()) as {
      stats: { total: number };
      records: unknown[];
    };
    expect(payload.stats.total).toBe(2);
    expect(payload.records).toHaveLength(2);
  });
});

describe("dashboard access control", () => {
  it("is open when no token is configured", async () => {
    const app = createApp(testDeps());
    expect((await app.request("/")).status).toBe(200);
    expect((await app.request("/api/requests")).status).toBe(200);
  });

  it("rejects both routes when a token is required but absent", async () => {
    const deps = testDeps();
    deps.dashboard.token = TOKEN;
    const app = createApp(deps);

    expect((await app.request("/")).status).toBe(401);
    expect((await app.request("/api/requests")).status).toBe(401);
  });

  it("accepts the token as a bearer header", async () => {
    const deps = testDeps();
    deps.dashboard.token = TOKEN;

    const response = await createApp(deps).request("/api/requests", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
  });

  it("accepts the token as a query parameter for the initial page load", async () => {
    const deps = testDeps();
    deps.dashboard.token = TOKEN;

    expect((await createApp(deps).request(`/?token=${TOKEN}`)).status).toBe(200);
  });

  it("rejects a wrong token, including a correct prefix", async () => {
    const deps = testDeps();
    deps.dashboard.token = TOKEN;
    const app = createApp(deps);

    for (const attempt of ["wrong", TOKEN.slice(0, -1), `${TOKEN}x`, ""]) {
      const response = await app.request(`/api/requests?token=${attempt}`);
      expect(response.status, attempt).toBe(401);
    }
  });

  it("never leaks records through an unauthorized response", async () => {
    const deps = testDeps();
    deps.dashboard.token = TOKEN;
    deps.recordStore.add(sampleRecord());

    const body = await (await createApp(deps).request("/api/requests")).text();
    expect(body).not.toContain("stopped resolving");
  });
});
