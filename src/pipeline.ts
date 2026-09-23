import type { SupportRequest } from "./domain/supportRequest.js";
import { TriageError, type TriageProvider } from "./domain/triage.js";
import {
  buildDegradedMessage,
  buildTriageMessage,
  type DegradedReason,
} from "./notifications/formatting.js";
import type { SlackNotifier } from "./notifications/slack.js";
import { errorInfo, type Logger } from "./utils/logger.js";

/**
 * Classify, then notify.
 *
 * Two rules drive the error handling here:
 *
 *  1. V1 must not suppress anything. Every valid customer support request
 *     produces a Slack notification, including when triage fails - the message
 *     is just marked UNCLASSIFIED so a human knows the labels are missing.
 *     (The `if (!result.actionRequired) return;` filter is deliberately NOT
 *     implemented; humans evaluate the classifier first.)
 *
 *  2. Nothing thrown in here propagates back to the webhook route. The route
 *     has already answered Intercom by the time this runs, and re-raising would
 *     only risk an unhandled rejection.
 */

export interface PipelineDeps {
  triage: TriageProvider;
  slack: SlackNotifier;
  logger: Logger;
}

function degradedReason(error: unknown): DegradedReason {
  return error instanceof TriageError ? error.reason : "provider_error";
}

export async function processSupportRequest(
  request: SupportRequest,
  deps: PipelineDeps,
): Promise<void> {
  const log = deps.logger.child({
    eventId: request.eventId,
    conversationId: request.conversationId,
  });

  let message: ReturnType<typeof buildTriageMessage>;
  let outcome: "classified" | "degraded";

  try {
    const result = await deps.triage.classify(request);
    message = buildTriageMessage(request, result);
    outcome = "classified";
    log.info("triage.classified", {
      category: result.category,
      priority: result.priority,
      actionRequired: result.actionRequired,
      confidence: Number(result.confidence.toFixed(2)),
    });
  } catch (error) {
    const reason = degradedReason(error);
    message = buildDegradedMessage(request, reason);
    outcome = "degraded";
    log.warn("triage.degraded", { reason, ...errorInfo(error) });
  }

  try {
    await deps.slack.notify(message);
    log.info("pipeline.notified", { outcome });
  } catch (error) {
    // Terminal. There is no retry: Intercom has already been acknowledged, and
    // retrying from here risks duplicate alerts without a durable queue.
    log.error("pipeline.slack_failed", { outcome, ...errorInfo(error) });
  }
}
