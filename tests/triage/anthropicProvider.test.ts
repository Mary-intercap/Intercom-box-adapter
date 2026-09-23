import { describe, expect, it, vi } from "vitest";

import { TriageError } from "../../src/domain/triage.js";
import {
  createAnthropicTriageProvider,
  createNoopTriageProvider,
} from "../../src/triage/anthropicProvider.js";
import { OPEN_DELIMITER } from "../../src/triage/prompt.js";
import { nullLogger } from "../../src/utils/logger.js";
import { sampleSupportRequest } from "../fixtures/deps.js";

const parsedOutput = {
  category: "dns",
  priority: "high",
  actionRequired: true,
  confidence: 0.91,
  summary: "Customer reports their .box domain stopped resolving.",
  suggestedResponse: "Thanks for reporting this. We'll take a look at the DNS status.",
  reasoningSummary: null,
};

/** Minimal stand-in for `client.messages.parse` - no network, no credentials. */
function stubMessages(response: unknown) {
  const parse = vi.fn((_args: Record<string, unknown>) => Promise.resolve(response));
  return { messages: { parse } as never, parse };
}

function provider(client: { parse: unknown }) {
  return createAnthropicTriageProvider({
    apiKey: "not-a-real-key",
    model: "claude-opus-5",
    effort: "low",
    timeoutMs: 1000,
    logger: nullLogger,
    client: client as never,
  });
}

describe("anthropic triage provider", () => {
  it("returns a validated result from structured output", async () => {
    const { messages, parse } = stubMessages({
      stop_reason: "end_turn",
      parsed_output: parsedOutput,
    });
    const result = await provider(messages).classify(sampleSupportRequest);

    expect(result.category).toBe("dns");
    expect(result.priority).toBe("high");
    expect(result.confidence).toBeCloseTo(0.91);
    expect(result.reasoningSummary).toBeUndefined();
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("sends the customer message as a user turn inside the delimiter, with no tools", async () => {
    const { messages, parse } = stubMessages({
      stop_reason: "end_turn",
      parsed_output: parsedOutput,
    });
    await provider(messages).classify(sampleSupportRequest);

    const args = parse.mock.calls[0]?.[0];
    if (!args) throw new Error("parse was not called");
    expect(args.model).toBe("claude-opus-5");
    expect(args.tools).toBeUndefined();

    const turns = args.messages as { role: string; content: string }[];
    expect(turns).toHaveLength(1);
    expect(turns[0]?.role).toBe("user");
    expect(turns[0]?.content).toContain(OPEN_DELIMITER);
    expect(turns[0]?.content).toContain("stopped resolving");

    // The system prompt is a constant; customer text is never in it.
    expect(args.system).not.toContain("stopped resolving");

    const outputConfig = args.output_config as Record<string, unknown>;
    expect(outputConfig.effort).toBe("low");
    expect(outputConfig.format).toBeDefined();
  });

  it("raises a refusal TriageError when the model declines", async () => {
    const { messages } = stubMessages({
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "cyber" },
      parsed_output: null,
    });
    await expect(provider(messages).classify(sampleSupportRequest)).rejects.toMatchObject({
      name: "TriageError",
      reason: "refusal",
    });
  });

  it("raises invalid_output when the response was truncated", async () => {
    const { messages } = stubMessages({ stop_reason: "max_tokens", parsed_output: null });
    await expect(provider(messages).classify(sampleSupportRequest)).rejects.toMatchObject({
      reason: "invalid_output",
    });
  });

  it("raises invalid_output when nothing parsed", async () => {
    const { messages } = stubMessages({ stop_reason: "end_turn", parsed_output: null });
    await expect(provider(messages).classify(sampleSupportRequest)).rejects.toMatchObject({
      reason: "invalid_output",
    });
  });

  it("raises invalid_output when the parsed result fails our own schema", async () => {
    const { messages } = stubMessages({
      stop_reason: "end_turn",
      parsed_output: { ...parsedOutput, category: "made_up_category" },
    });
    await expect(provider(messages).classify(sampleSupportRequest)).rejects.toMatchObject({
      reason: "invalid_output",
    });
  });

  it("raises provider_error when the SDK call throws", async () => {
    const parse = vi.fn((_args: Record<string, unknown>) =>
      Promise.reject(new Error("503 Service Unavailable")),
    );
    await expect(provider({ parse }).classify(sampleSupportRequest)).rejects.toBeInstanceOf(
      TriageError,
    );
  });

  it("does not put the API key into the thrown error", async () => {
    const parse = vi.fn((_args: Record<string, unknown>) =>
      Promise.reject(new Error("auth failed")),
    );
    try {
      await provider({ parse }).classify(sampleSupportRequest);
      expect.unreachable();
    } catch (error) {
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(
        "not-a-real-key",
      );
    }
  });
});

describe("noop triage provider", () => {
  it("always reports not_configured", async () => {
    await expect(createNoopTriageProvider().classify(sampleSupportRequest)).rejects.toMatchObject({
      reason: "not_configured",
    });
  });
});
