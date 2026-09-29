import { timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";

import { z } from "zod";

import type { TriageOverride } from "../domain/triageRecord.js";
import { TRIAGE_CATEGORIES, TRIAGE_PRIORITIES } from "../triage/schema.js";
import { errorInfo, type Logger } from "../utils/logger.js";
import { DASHBOARD_HTML } from "./page.js";
import type { TriageRecordStore } from "./store.js";

/**
 * Dashboard routes.
 *
 *   GET /               the page
 *   GET /api/requests   the data behind it
 *
 * ## Access control
 *
 * These responses contain customer support messages verbatim. On localhost that
 * is fine. Anywhere reachable by anyone else it is a data leak, so a token can
 * be required via DASHBOARD_TOKEN - supplied as `Authorization: Bearer <token>`
 * or, for the initial page load, `?token=<token>`.
 *
 * This is deliberately a shared secret rather than real authentication. It is
 * appropriate for an internal tool behind a VPN or on localhost; it is not a
 * substitute for SSO on a public endpoint.
 */

export interface DashboardDeps {
  store: TriageRecordStore;
  /** When set, every dashboard request must present this token. */
  token?: string | undefined;
  logger?: Logger;
  /** Injection seam for tests. */
  now?: () => Date;
}

/**
 * A human correction. Both fields optional so the UI can change one without
 * restating the other, but at least one must be present - an empty body is a
 * mistake, not a no-op worth recording.
 */
const overrideSchema = z
  .object({
    category: z.enum(TRIAGE_CATEGORIES).optional(),
    priority: z.enum(TRIAGE_PRIORITIES).optional(),
  })
  .refine(
    (value) => value.category !== undefined || value.priority !== undefined,
    "provide at least one of category or priority",
  );

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 200;

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  // Length is not secret, and timingSafeEqual requires equal lengths.
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Writes accept the token ONLY as a bearer header, never as `?token=`.
 *
 * A query parameter travels in links, bookmarks and browser history, so a
 * URL-authenticated write could be triggered by anything that gets someone to
 * follow a link. Requiring a header means a cross-origin page cannot forge the
 * request without a CORS preflight it will not be granted.
 */
function isAuthorizedForWrite(c: Context, expected: string | undefined): boolean {
  if (!expected) return true;
  const header = c.req.header("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  return tokenMatches(header.slice("Bearer ".length).trim(), expected);
}

function isAuthorized(c: Context, expected: string | undefined): boolean {
  if (!expected) return true;

  const header = c.req.header("authorization");
  if (header?.startsWith("Bearer ")) {
    if (tokenMatches(header.slice("Bearer ".length).trim(), expected)) return true;
  }
  const query = c.req.query("token");
  if (query && tokenMatches(query, expected)) return true;

  return false;
}

export function registerDashboardRoutes(app: Hono, deps: DashboardDeps): void {
  app.get("/", (c) => {
    if (!isAuthorized(c, deps.token)) {
      return c.text("Unauthorized. Append ?token=… to the URL.", 401);
    }
    return c.html(DASHBOARD_HTML, 200, {
      // The page loads no external resources, so it can afford a strict policy.
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      // The page is a single inline document with no asset URLs to bust, so a
      // cached copy survives every redeploy and silently hides new controls.
      // It is also customer data, which should not sit in a browser cache.
      "cache-control": "no-store, must-revalidate",
    });
  });

  app.patch("/api/requests/:eventId", async (c) => {
    if (!isAuthorizedForWrite(c, deps.token)) {
      return c.json({ error: "unauthorized" }, 401);
    }

    const eventId = c.req.param("eventId");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_payload" }, 400);
    }

    const parsed = overrideSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid_payload", detail: parsed.error.issues[0]?.message ?? "invalid" },
        400,
      );
    }

    const override: TriageOverride = {
      ...parsed.data,
      at: (deps.now ?? (() => new Date()))().toISOString(),
    };

    let updated;
    try {
      updated = deps.store.applyOverride(eventId, override);
    } catch (error) {
      deps.logger?.error("dashboard.override_failed", { eventId, ...errorInfo(error) });
      return c.json({ error: "internal_error" }, 500);
    }

    if (!updated) {
      // Usually means the ring buffer has already forgotten this record.
      return c.json({ error: "not_found" }, 404);
    }

    // The classifier's mistakes are the signal this whole version exists to
    // gather, so corrections are logged - labels only, never message text.
    deps.logger?.info("dashboard.reclassified", {
      eventId,
      conversationId: updated.request.conversationId,
      fromCategory: updated.result?.category ?? null,
      toCategory: override.category ?? null,
      fromPriority: updated.result?.priority ?? null,
      toPriority: override.priority ?? null,
    });

    return c.json({ record: updated }, 200, { "cache-control": "no-store" });
  });

  app.get("/api/requests", (c) => {
    if (!isAuthorized(c, deps.token)) {
      return c.json({ error: "unauthorized" }, 401);
    }

    const requested = Number.parseInt(c.req.query("limit") ?? "", 10);
    const limit = Number.isFinite(requested)
      ? Math.min(Math.max(requested, 1), MAX_LIMIT)
      : DEFAULT_LIMIT;

    return c.json(
      {
        stats: deps.store.stats(),
        records: deps.store.list({ limit }),
      },
      200,
      // Customer data: never cached by an intermediary.
      { "cache-control": "no-store", "referrer-policy": "no-referrer" },
    );
  });
}
