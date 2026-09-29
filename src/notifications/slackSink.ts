import type { NotificationSink, TriageRecord } from "../domain/triageRecord.js";
import { buildDegradedMessage, buildTriageMessage } from "./formatting.js";
import type { SlackNotifier } from "./slack.js";

/**
 * Adapts the Slack webhook notifier to the {@link NotificationSink} interface:
 * domain record in, Slack Block Kit out.
 */
export function createSlackSink(notifier: SlackNotifier): NotificationSink {
  return {
    name: "slack",
    notify(record: TriageRecord): Promise<void> {
      const message =
        record.result === null
          ? buildDegradedMessage(record.request, record.degradedReason ?? "provider_error")
          : buildTriageMessage(record.request, record.result);
      return notifier.notify(message);
    },
  };
}
