import { z } from "zod";

/**
 * Typed, validated configuration.
 *
 * Requirements are conditional on the configured execution path: the Anthropic
 * key is only required when AI_PROVIDER=anthropic. Validation failures list the
 * offending *variable names* only - never their values - so a misconfigured
 * deploy cannot print a secret into a crash log.
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export const AI_PROVIDERS = ["anthropic", "mock", "noop"] as const;
export const AI_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

const booleanish = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),

  INTERCOM_CLIENT_SECRET: z.string().min(1, "must not be empty"),
  // Unused in V1 - the webhook payload carries everything we need and the V1
  // Intercom app only holds "Read conversations". Reserved for V2.
  INTERCOM_ACCESS_TOKEN: z.string().min(1).optional(),

  // Optional: the dashboard is the default sink. Set this only if you also want
  // notifications posted to Slack.
  SLACK_WEBHOOK_URL: z.url("must be a valid URL").optional(),
  SLACK_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),

  /** Shared secret gating the dashboard. Unset = open, which is fine on localhost. */
  DASHBOARD_TOKEN: z.string().min(16, "must be at least 16 characters").optional(),
  DASHBOARD_MAX_RECORDS: z.coerce.number().int().min(1).max(10_000).default(200),

  AI_PROVIDER: z.enum(AI_PROVIDERS).default("anthropic"),
  AI_API_KEY: z.string().min(1).optional(),
  AI_MODEL: z.string().min(1).default("claude-opus-5"),
  AI_EFFORT: z.enum(AI_EFFORTS).default("low"),
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(30_000),

  /** Escape hatch for local testing against a non-Slack mock endpoint. */
  SLACK_ALLOW_NON_SLACK_URL: booleanish.default(false),
});

export type Config = Readonly<z.infer<typeof envSchema>>;

export class ConfigError extends Error {
  override readonly name = "ConfigError";
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
}

/**
 * Parses configuration from an environment-like record.
 *
 * Throws {@link ConfigError} listing variable names and the reason each failed.
 * Values are never included in the error message.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat empty strings as absent - a blank var in a .env file is a common
  // mistake and `""` would otherwise pass `.optional()` checks.
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" && value.trim() !== "") cleaned[key] = value;
  }

  const result = envSchema.safeParse(cleaned);

  const problems: string[] = [];
  const flagged = new Set<string>();
  if (!result.success) {
    for (const issue of result.error.issues) {
      const name = issue.path.join(".") || "(unknown)";
      flagged.add(name);
      problems.push(`${name}: ${issue.message}`);
    }
  }

  // Cross-field rules run against the raw values rather than inside a Zod
  // refinement, so that a missing unrelated variable does not hide them. A
  // fail-fast service should report every misconfiguration on the first boot,
  // not one per restart.
  const add = (name: string, message: string): void => {
    if (flagged.has(name)) return;
    flagged.add(name);
    problems.push(`${name}: ${message}`);
  };

  const provider = cleaned.AI_PROVIDER ?? "anthropic";
  if (provider === "anthropic" && !cleaned.AI_API_KEY) {
    add("AI_API_KEY", "is required when AI_PROVIDER=anthropic");
  }

  // Slack is optional, but if a URL is given it has to be a plausible one.
  const slackUrl = cleaned.SLACK_WEBHOOK_URL;
  if (slackUrl !== undefined && !flagged.has("SLACK_WEBHOOK_URL")) {
    const allowNonSlack =
      cleaned.SLACK_ALLOW_NON_SLACK_URL === "true" || cleaned.SLACK_ALLOW_NON_SLACK_URL === "1";
    if (!slackUrl.startsWith("https://")) {
      add("SLACK_WEBHOOK_URL", "must use https");
    } else if (!allowNonSlack && !slackUrl.startsWith("https://hooks.slack.com/")) {
      add(
        "SLACK_WEBHOOK_URL",
        "must point at https://hooks.slack.com/ (set SLACK_ALLOW_NON_SLACK_URL=true to override for local testing)",
      );
    }
  }

  if (problems.length > 0) throw new ConfigError(problems);
  // `result.success` is guaranteed here: any parse failure added a problem.
  return Object.freeze((result as Extract<typeof result, { success: true }>).data);
}
