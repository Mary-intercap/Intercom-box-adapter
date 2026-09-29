import {
  effectiveCategory,
  effectivePriority,
  wasCorrected,
  type TriageOverride,
  type TriageRecord,
} from "../domain/triageRecord.js";
import type { TriageCategory, TriagePriority } from "../triage/schema.js";

/**
 * Storage for the dashboard's recent-requests view.
 *
 * !! IN-MEMORY, AND NOT A SYSTEM OF RECORD. !!
 *
 * A bounded ring buffer in one process's heap: everything is lost on restart,
 * redeploy, or crash, and nothing is shared between instances. That is a
 * deliberate V1 choice - the dashboard exists so humans can evaluate the
 * classifier against live traffic, not to be an audit log. Intercom remains the
 * system of record for the conversations themselves.
 *
 * Swap this for a real store (SQLite, Postgres, KV) if the triage history needs
 * to survive a deploy.
 */
export interface TriageRecordStore {
  add(record: TriageRecord): void;
  /**
   * Records a human correction against a stored record. Returns the updated
   * record, or null when the event id is unknown - which happens routinely,
   * because the ring buffer forgets old records.
   */
  applyOverride(eventId: string, override: TriageOverride): TriageRecord | null;
  /** Newest first. */
  list(options?: { limit?: number }): TriageRecord[];
  stats(): DashboardStats;
  size(): number;
}

export interface DashboardStats {
  total: number;
  classified: number;
  degraded: number;
  actionRequired: number;
  /** How many records a human has corrected. The classifier's error count. */
  corrected: number;
  byPriority: Record<TriagePriority, number>;
  byCategory: Partial<Record<TriageCategory, number>>;
}

export interface MemoryRecordStoreOptions {
  /** Hard cap on retained records. Default 200. */
  maxRecords?: number;
}

export function createMemoryRecordStore(options: MemoryRecordStoreOptions = {}): TriageRecordStore {
  const maxRecords = options.maxRecords ?? 200;
  // Newest last; `list` reverses. Kept as a plain array because the cap is
  // small and shift() on a few hundred entries is not worth optimising.
  const records: TriageRecord[] = [];

  return {
    add(record: TriageRecord): void {
      records.push(record);
      while (records.length > maxRecords) records.shift();
    },

    applyOverride(eventId: string, override: TriageOverride): TriageRecord | null {
      const index = records.findIndex((record) => record.request.eventId === eventId);
      if (index === -1) return null;

      const existing = records[index];
      if (!existing) return null;

      // Merge rather than replace, so correcting only the priority does not
      // silently discard an earlier category correction.
      const updated: TriageRecord = {
        ...existing,
        override: { ...existing.override, ...override },
      };
      records[index] = updated;
      return updated;
    },

    list(listOptions: { limit?: number } = {}): TriageRecord[] {
      const newestFirst = [...records].reverse();
      const limit = listOptions.limit;
      return limit === undefined ? newestFirst : newestFirst.slice(0, Math.max(0, limit));
    },

    size(): number {
      return records.length;
    },

    stats(): DashboardStats {
      const byPriority: Record<TriagePriority, number> = {
        low: 0,
        medium: 0,
        high: 0,
        critical: 0,
      };
      const byCategory: Partial<Record<TriageCategory, number>> = {};
      let classified = 0;
      let degraded = 0;
      let actionRequired = 0;
      let corrected = 0;

      for (const record of records) {
        if (wasCorrected(record)) corrected += 1;

        if (record.result === null && !record.override) {
          degraded += 1;
          continue;
        }
        classified += 1;

        // Counts follow the human when there is one: the queue should reflect
        // what is true, not what the model first guessed.
        const priority = effectivePriority(record);
        const category = effectiveCategory(record);
        if (priority) byPriority[priority] += 1;
        if (category) byCategory[category] = (byCategory[category] ?? 0) + 1;
        if (record.result?.actionRequired) actionRequired += 1;
      }

      return {
        total: records.length,
        classified,
        degraded,
        actionRequired,
        corrected,
        byPriority,
        byCategory,
      };
    },
  };
}
