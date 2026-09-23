import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import type { SupportRequest } from "../domain/supportRequest.js";
import { TriageError, type TriageProvider } from "../domain/triage.js";
import { buildUserPrompt, SYSTEM_PROMPT } from "./prompt.js";
import { modelOutputSchema, toTriageResult, type TriageResult } from "./schema.js";
import type { Logger } from "../utils/logger.js";
import { errorInfo } from "../utils/logger.js";

/**
 * Claude-backed triage provider.
 *
 * Uses structured outputs (`messages.parse` + `zodOutputFormat`) so the model
 * can only return the triage schema. No tools are supplied: the model has no
 * capability to call anything, which is the main reason a prompt injection in a
 * customer message cannot do anything beyond skewing a classification.
 *
 * Docs: https://platform.claude.com/docs/en/api/messages
 *       https://platform.claude.com/docs/en/build-with-claude/structured-outputs
 */

/** Deliberately small: the schema output is short and thinking runs at low effort. */
const MAX_TOKENS = 4096;

/**
 * The subset of the parse response this provider reads. The SDK's own return
 * type is generic over the output format, which erases to `any` once the client
 * is behind the injectable `Pick<..., "parse">` seam - so we name what we rely
 * on and assert it once, at the boundary.
 */
interface ParsedTriageResponse {
  stop_reason: string | null;
  stop_details?: { category?: string | null } | null;
  parsed_output: unknown;
}

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs: number;
  logger: Logger;
  /** Injection seam for tests. */
  client?: Pick<Anthropic["messages"], "parse">;
}

export function createAnthropicTriageProvider(options: AnthropicProviderOptions): TriageProvider {
  const messages =
    options.client ??
    new Anthropic({
      apiKey: options.apiKey,
      timeout: options.timeoutMs,
      maxRetries: 2,
    }).messages;

  return {
    async classify(request: SupportRequest): Promise<TriageResult> {
      let response: ParsedTriageResponse;
      try {
        response = await messages.parse({
          model: options.model,
          max_tokens: MAX_TOKENS,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: buildUserPrompt(request) }],
          output_config: {
            effort: options.effort,
            format: zodOutputFormat(modelOutputSchema),
          },
        });
      } catch (error) {
        const info = errorInfo(error);
        options.logger.error("triage.provider_error", {
          eventId: request.eventId,
          conversationId: request.conversationId,
          ...info,
        });
        const isTimeout = error instanceof Anthropic.APIConnectionTimeoutError;
        throw new TriageError(info.errorMessage, isTimeout ? "timeout" : "provider_error");
      }

      if (response.stop_reason === "refusal") {
        // A safety classifier declined. That is a signal about the message, not
        // a crash: the pipeline still notifies Slack, flagged for a human.
        options.logger.warn("triage.refusal", {
          eventId: request.eventId,
          conversationId: request.conversationId,
          category: response.stop_details?.category ?? null,
        });
        throw new TriageError("model declined to classify this message", "refusal");
      }

      if (response.stop_reason === "max_tokens") {
        throw new TriageError("model output was truncated", "invalid_output");
      }

      if (response.parsed_output === null || response.parsed_output === undefined) {
        throw new TriageError("model returned no parseable structured output", "invalid_output");
      }

      try {
        return toTriageResult(response.parsed_output);
      } catch (error) {
        options.logger.error("triage.invalid_output", {
          eventId: request.eventId,
          conversationId: request.conversationId,
          ...errorInfo(error),
        });
        throw new TriageError("model output failed schema validation", "invalid_output");
      }
    },
  };
}

/**
 * Provider used when AI_PROVIDER=noop. Lets Intercom -> Slack wiring be tested
 * end to end before AI credentials exist; every request degrades to an
 * explicitly unclassified Slack notification.
 */
export function createNoopTriageProvider(): TriageProvider {
  return {
    classify(): Promise<TriageResult> {
      return Promise.reject(
        new TriageError("AI_PROVIDER=noop: no classifier configured", "not_configured"),
      );
    },
  };
}
