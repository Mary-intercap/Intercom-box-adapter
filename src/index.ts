import { serve } from "@hono/node-server";

import { createApp } from "./app.js";
import { ConfigError, loadConfig, type Config } from "./config/env.js";
import type { TriageProvider } from "./domain/triage.js";
import { createSlackWebhookNotifier } from "./notifications/slack.js";
import { backgroundDefer } from "./runtime.js";
import { createMemoryEventStore } from "./store/memoryEventStore.js";
import {
  createAnthropicTriageProvider,
  createNoopTriageProvider,
} from "./triage/anthropicProvider.js";
import { createLogger, type Logger } from "./utils/logger.js";

/**
 * Node entrypoint - the composition root.
 *
 * This is the only module that reads the environment, constructs real clients,
 * or binds a port. Everything else takes its dependencies as arguments, which
 * is what lets the tests run with no network and no credentials.
 */

function buildTriageProvider(config: Config, logger: Logger): TriageProvider {
  if (config.AI_PROVIDER === "noop") {
    logger.warn("startup.triage_disabled", {
      detail: "AI_PROVIDER=noop - all requests will produce UNCLASSIFIED notifications",
    });
    return createNoopTriageProvider();
  }
  return createAnthropicTriageProvider({
    // Guaranteed present: config validation requires it for this provider.
    apiKey: config.AI_API_KEY as string,
    model: config.AI_MODEL,
    effort: config.AI_EFFORT,
    timeoutMs: config.AI_TIMEOUT_MS,
    logger,
  });
}

function main(): void {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      // Names and reasons only - never values.
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  const logger = createLogger({ level: config.LOG_LEVEL });

  if (config.LOG_LEVEL === "debug" && config.NODE_ENV === "production") {
    logger.warn("startup.debug_logging_in_production", {
      detail: "LOG_LEVEL=debug logs customer message bodies",
    });
  }

  const app = createApp({
    clientSecret: config.INTERCOM_CLIENT_SECRET,
    eventStore: createMemoryEventStore(),
    triage: buildTriageProvider(config, logger),
    slack: createSlackWebhookNotifier({
      webhookUrl: config.SLACK_WEBHOOK_URL,
      timeoutMs: config.SLACK_TIMEOUT_MS,
    }),
    defer: backgroundDefer,
    logger,
  });

  const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    logger.info("startup.listening", {
      port: info.port,
      nodeEnv: config.NODE_ENV,
      aiProvider: config.AI_PROVIDER,
      aiModel: config.AI_PROVIDER === "anthropic" ? config.AI_MODEL : null,
      logLevel: config.LOG_LEVEL,
    });
  });

  const shutdown = (signal: string) => {
    logger.info("shutdown.signal", { signal });
    server.close(() => process.exit(0));
    // In-flight background work has no durable queue behind it; give it a
    // moment to finish rather than cutting it off instantly.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main();
