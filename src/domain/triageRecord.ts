import type { SupportRequest } from "./supportRequest.js";
import type { TriageCategory, TriagePriority, TriageResult } from "../triage/schema.js";

/** Why a request could not be classified. */
export type DegradedReason =
  "provider_error" | "invalid_output" | "refusal" | "timeout" | "not_configured";

/**
 * One fully-processed support request: what came in, and what triage made of
 * it. This is what the pipeline produces and what every notification sink
 * consumes.
 *
 * `result` is null exactly when `degradedReason` is set. V1 never drops a
 * request because triage failed - it records it as unclassified instead.
 */
export type TriageRecord = {
  request: SupportRequest;
  result: TriageResult | null;
  degradedReason: DegradedReason | null;
  /** ISO-8601. When this service finished processing, not when the customer wrote. */
  processedAt: string;
  /** A human correction of the AI's labels. Absent until someone makes one. */
  override?: TriageOverride | null;
};

/**
 * A human correcting the classifier.
 *
 * Deliberately stored ALONGSIDE `result` rather than replacing it. The point of
 * V1 is to find out how good the classifier is before trusting it, and that
 * question is unanswerable if a correction destroys what the model originally
 * said. Reads go through {@link effectiveCategory} / {@link effectivePriority},
 * which prefer the human; the model's answer stays on the record for
 * comparison.
 *
 * There is no author field. The dashboard authenticates with a shared token,
 * not per-person credentials, so there is no identity to record and inventing
 * one would be worse than leaving it out.
 */
export type TriageOverride = {
  category?: TriageCategory;
  priority?: TriagePriority;
  /** ISO-8601. */
  at: string;
};

/** The category to act on: the human's if they corrected it, else the model's. */
export function effectiveCategory(record: TriageRecord): TriageCategory | null {
  return record.override?.category ?? record.result?.category ?? null;
}

/** The priority to act on: the human's if they corrected it, else the model's. */
export function effectivePriority(record: TriageRecord): TriagePriority | null {
  return record.override?.priority ?? record.result?.priority ?? null;
}

/** True when a human changed something the model said. */
export function wasCorrected(record: TriageRecord): boolean {
  const override = record.override;
  if (!override) return false;
  const categoryChanged =
    override.category !== undefined && override.category !== record.result?.category;
  const priorityChanged =
    override.priority !== undefined && override.priority !== record.result?.priority;
  return categoryChanged || priorityChanged;
}

/**
 * A destination for processed requests - the dashboard, Slack, or anything
 * added later. Sinks receive the domain record and decide their own
 * presentation; the pipeline does no formatting.
 */
export interface NotificationSink {
  /** A human-readable name, used in logs. */
  readonly name: string;
  notify(record: TriageRecord): Promise<void>;
}
