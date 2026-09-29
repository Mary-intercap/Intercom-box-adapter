import type { NotificationSink, TriageRecord } from "../domain/triageRecord.js";
import type { TriageRecordStore } from "./store.js";

/**
 * Records every processed request for the dashboard.
 *
 * Synchronous and infallible by construction - an in-memory append cannot fail
 * in a way worth handling - which is what makes it a safe default sink: the
 * service can always show what it did, even when every outbound integration is
 * down.
 */
export function createDashboardSink(store: TriageRecordStore): NotificationSink {
  return {
    name: "dashboard",
    notify(record: TriageRecord): Promise<void> {
      store.add(record);
      return Promise.resolve();
    },
  };
}
