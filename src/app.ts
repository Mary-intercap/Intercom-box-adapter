import { Hono } from "hono";

import { registerDashboardRoutes, type DashboardDeps } from "./dashboard/routes.js";
import { createIntercomWebhookHandler, type WebhookDeps } from "./intercom/webhook.js";
import { errorInfo } from "./utils/logger.js";

export interface AppDeps extends WebhookDeps {
  dashboard: DashboardDeps;
}

/**
 * Builds the HTTP surface.
 *
 * Platform-free on purpose: this returns a Hono app and knows nothing about
 * Node, ports, or process lifecycle. `index.ts` owns all of that, which is what
 * makes the service portable to a container or a serverless handler.
 */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.post("/webhooks/intercom", createIntercomWebhookHandler(deps));

  registerDashboardRoutes(app, { logger: deps.logger, ...deps.dashboard });

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  app.onError((error, c) => {
    // Last line of defence. Internals stay in the log; the caller gets nothing.
    deps.logger.error("http.unhandled_error", {
      path: c.req.path,
      method: c.req.method,
      ...errorInfo(error),
    });
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}
