import type { SupportRequest } from "./domain/supportRequest.js";
import { TriageError, type TriageProvider } from "./domain/triage.js";
import type { DegradedReason, NotificationSink, TriageRecord } from "./domain/triageRecord.js";
import type { TriageResult } from "./triage/schema.js";
import { errorInfo, type Logger } from "./utils/logger.js";

/**
 * Classify, then hand the result to the notification sinks.
 *
 * Two rules drive the error handling here:
 *
 *  1. V1 must not suppress anything. Every valid customer support request
 *     produces a notification, including when triage fails - the record is just
 *     marked unclassified so a human knows the labels are missing.
 *     (The `if (!result.actionRequired) return;` filter is deliberately NOT
 *     implemented; humans evaluate the classifier first.)
 *
 *  2. Nothing thrown in here propagates back to the webhook route. The route
 *     has already answered Intercom by the time this runs, and re-raising would
 *     only risk an unhandled rejection.
 *
 * The pipeline does no formatting. It produces a domain {@link TriageRecord};
 * each sink decides how to present it.
 */

export interface PipelineDeps {
  triage: TriageProvider;
  sink: NotificationSink;
  logger: Logger;
  /** Injection seam for tests. */
  now?: () => Date;
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
  const now = deps.now ?? (() => new Date());

  let result: TriageResult | null = null;
  let reason: DegradedReason | null = null;

  try {
    result = await deps.triage.classify(request);
    log.info("triage.classified", {
      category: result.category,
      priority: result.priority,
      actionRequired: result.actionRequired,
      confidence: Number(result.confidence.toFixed(2)),
    });
  } catch (error) {
    reason = degradedReason(error);
    log.warn("triage.degraded", { reason, ...errorInfo(error) });
  }

  const record: TriageRecord = {
    request,
    result,
    degradedReason: reason,
    processedAt: now().toISOString(),
  };

  try {
    await deps.sink.notify(record);
    log.info("pipeline.notified", {
      outcome: result === null ? "degraded" : "classified",
      sink: deps.sink.name,
    });
  } catch (error) {
    // Terminal. There is no retry: Intercom has already been acknowledged, and
    // retrying from here risks duplicate alerts without a durable queue.
    log.error("pipeline.notify_failed", {
      outcome: result === null ? "degraded" : "classified",
      sink: deps.sink.name,
      ...errorInfo(error),
    });
  }
}
