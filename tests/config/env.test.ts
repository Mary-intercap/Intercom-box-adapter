import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../../src/config/env.js";

const MINIMAL = {
  INTERCOM_CLIENT_SECRET: "client-secret-value",
  SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T000/B000/xxx",
  AI_API_KEY: "sk-ant-not-a-real-key",
};

describe("loadConfig", () => {
  it("applies documented defaults", () => {
    const config = loadConfig(MINIMAL);
    expect(config).toMatchObject({
      NODE_ENV: "development",
      PORT: 3000,
      LOG_LEVEL: "info",
      AI_PROVIDER: "anthropic",
      AI_MODEL: "claude-opus-5",
      AI_EFFORT: "low",
    });
  });

  it("coerces numeric variables", () => {
    const config = loadConfig({ ...MINIMAL, PORT: "8080", AI_TIMEOUT_MS: "15000" });
    expect(config.PORT).toBe(8080);
    expect(config.AI_TIMEOUT_MS).toBe(15000);
  });

  it("requires the Intercom client secret", () => {
    const { INTERCOM_CLIENT_SECRET: _omitted, ...rest } = MINIMAL;
    expect(() => loadConfig(rest)).toThrow(ConfigError);
  });

  it("treats a blank variable as missing", () => {
    expect(() => loadConfig({ ...MINIMAL, INTERCOM_CLIENT_SECRET: "   " })).toThrow(ConfigError);
  });

  it("requires the AI key only on the anthropic path", () => {
    const { AI_API_KEY: _omitted, ...rest } = MINIMAL;
    expect(() => loadConfig(rest)).toThrow(/AI_API_KEY/);
    expect(() => loadConfig({ ...rest, AI_PROVIDER: "noop" })).not.toThrow();
  });

  it("does not require the Intercom access token in V1", () => {
    expect(loadConfig(MINIMAL).INTERCOM_ACCESS_TOKEN).toBeUndefined();
  });

  it("rejects a non-Slack webhook host by default", () => {
    expect(() =>
      loadConfig({ ...MINIMAL, SLACK_WEBHOOK_URL: "https://evil.example/hook" }),
    ).toThrow(/SLACK_WEBHOOK_URL/);
  });

  it("allows a non-Slack host behind the explicit local-testing flag", () => {
    const config = loadConfig({
      ...MINIMAL,
      SLACK_WEBHOOK_URL: "https://localhost.example/hook",
      SLACK_ALLOW_NON_SLACK_URL: "true",
    });
    expect(config.SLACK_WEBHOOK_URL).toBe("https://localhost.example/hook");
  });

  it("rejects a plaintext webhook URL", () => {
    expect(() =>
      loadConfig({
        ...MINIMAL,
        SLACK_WEBHOOK_URL: "http://hooks.slack.com/services/T/B/x",
        SLACK_ALLOW_NON_SLACK_URL: "true",
      }),
    ).toThrow(/https/);
  });

  it("rejects an out-of-range port and an unknown log level", () => {
    expect(() => loadConfig({ ...MINIMAL, PORT: "0" })).toThrow(/PORT/);
    expect(() => loadConfig({ ...MINIMAL, LOG_LEVEL: "verbose" })).toThrow(/LOG_LEVEL/);
  });

  it("reports every problem at once, by name", () => {
    const error = (() => {
      try {
        loadConfig({ AI_PROVIDER: "anthropic" });
        return null;
      } catch (e) {
        return e as ConfigError;
      }
    })();

    expect(error).toBeInstanceOf(ConfigError);
    expect(error?.problems.join("\n")).toContain("INTERCOM_CLIENT_SECRET");
    expect(error?.problems.join("\n")).toContain("AI_API_KEY");
  });

  it("treats Slack as optional - the dashboard is the default sink", () => {
    const { SLACK_WEBHOOK_URL: _omitted, ...rest } = MINIMAL;
    const config = loadConfig(rest);
    expect(config.SLACK_WEBHOOK_URL).toBeUndefined();
  });

  it("still validates a Slack URL when one is supplied", () => {
    expect(() =>
      loadConfig({ ...MINIMAL, SLACK_WEBHOOK_URL: "https://evil.example/hook" }),
    ).toThrow(/SLACK_WEBHOOK_URL/);
  });

  it("leaves the dashboard open by default and bounds its history", () => {
    const config = loadConfig(MINIMAL);
    expect(config.DASHBOARD_TOKEN).toBeUndefined();
    expect(config.DASHBOARD_MAX_RECORDS).toBe(200);
  });

  it("rejects a dashboard token that is too short to be worth having", () => {
    expect(() => loadConfig({ ...MINIMAL, DASHBOARD_TOKEN: "short" })).toThrow(/DASHBOARD_TOKEN/);
    expect(() =>
      loadConfig({ ...MINIMAL, DASHBOARD_TOKEN: "a-sufficiently-long-token" }),
    ).not.toThrow();
  });

  it("never includes a secret value in the error message", () => {
    const error = (() => {
      try {
        loadConfig({ ...MINIMAL, SLACK_WEBHOOK_URL: "not-a-url" });
        return null;
      } catch (e) {
        return e as ConfigError;
      }
    })();
    expect(error?.message).not.toContain("client-secret-value");
    expect(error?.message).not.toContain("sk-ant-not-a-real-key");
  });
});
