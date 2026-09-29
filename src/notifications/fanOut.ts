import type { NotificationSink, TriageRecord } from "../domain/triageRecord.js";
import { errorInfo, type Logger } from "../utils/logger.js";

/**
 * Delivers each record to every sink.
 *
 * Failures are isolated per sink: a Slack outage must not stop the record
 * reaching the dashboard, and vice versa. The combined call resolves unless
 * *every* sink failed, which is the only case the caller can meaningfully treat
 * as "this request produced no notification anywhere".
 */
export function createFanOutSink(
  sinks: readonly NotificationSink[],
  logger: Logger,
): NotificationSink {
  return {
    name: sinks.map((sink) => sink.name).join("+") || "none",

    async notify(record: TriageRecord): Promise<void> {
      if (sinks.length === 0) return;

      const outcomes = await Promise.all(
        sinks.map(async (sink) => {
          try {
            await sink.notify(record);
            return true;
          } catch (error) {
            logger.error("sink.failed", {
              sink: sink.name,
              eventId: record.request.eventId,
              conversationId: record.request.conversationId,
              ...errorInfo(error),
            });
            return false;
          }
        }),
      );

      if (!outcomes.includes(true)) {
        throw new Error(`all ${String(sinks.length)} notification sinks failed`);
      }
    },
  };
}
