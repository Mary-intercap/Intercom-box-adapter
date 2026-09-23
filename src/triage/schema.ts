import { z } from "zod";

/**
 * Two schemas, deliberately.
 *
 * `modelOutputSchema` is the contract handed to the model via structured
 * outputs. It is intentionally plain - enums, booleans, a number, strings -
 * because the structured-output JSON Schema subset does not support every Zod
 * refinement, and a rejected schema is a runtime 400 rather than a type error.
 * `reasoningSummary` is `.nullable()` rather than `.optional()` because strict
 * structured outputs require every property to be present.
 *
 * `triageResultSchema` is our own stricter validation of what came back. The
 * model is an untrusted producer like any other: bounds are enforced here, not
 * hoped for.
 */

export const TRIAGE_CATEGORIES = [
  "dns",
  "domain_registration",
  "billing",
  "account",
  "technical_issue",
  "feature_request",
  "security",
  "abuse",
  "general",
  "other",
] as const;

export const TRIAGE_PRIORITIES = ["low", "medium", "high", "critical"] as const;

export type TriageCategory = (typeof TRIAGE_CATEGORIES)[number];
export type TriagePriority = (typeof TRIAGE_PRIORITIES)[number];

export const modelOutputSchema = z.object({
  category: z
    .enum(TRIAGE_CATEGORIES)
    .describe("The single best-fitting category for the customer's issue."),
  priority: z
    .enum(TRIAGE_PRIORITIES)
    .describe("Urgency of the issue, following the priority guidance in the instructions."),
  actionRequired: z
    .boolean()
    .describe("True if this request needs a human teammate to take action."),
  confidence: z.number().describe("Confidence in this classification, from 0 to 1 inclusive."),
  summary: z
    .string()
    .describe("One or two sentences summarising the customer's issue, in neutral language."),
  suggestedResponse: z
    .string()
    .describe(
      "A short draft reply a human could send. It is a suggestion only and is never sent automatically.",
    ),
  reasoningSummary: z
    .string()
    .nullable()
    .describe(
      "A concise, user-safe one-sentence explanation of why this classification was chosen, or null.",
    ),
});

export type ModelOutput = z.infer<typeof modelOutputSchema>;

export const triageResultSchema = z.object({
  category: z.enum(TRIAGE_CATEGORIES),
  priority: z.enum(TRIAGE_PRIORITIES),
  actionRequired: z.boolean(),
  confidence: z.number().min(0).max(1),
  summary: z.string().min(1).max(2000),
  suggestedResponse: z.string().min(1).max(4000),
  reasoningSummary: z.string().min(1).max(1000).optional(),
});

export type TriageResult = z.infer<typeof triageResultSchema>;

/**
 * Normalises a raw model output into a validated {@link TriageResult}.
 * Throws a ZodError when the output cannot be trusted.
 */
export function toTriageResult(raw: unknown): TriageResult {
  const candidate = raw as Partial<ModelOutput> | null | undefined;
  const normalized: Record<string, unknown> = { ...(candidate ?? {}) };

  // Clamp rather than reject: a model returning 1.02 is a formatting slip, not
  // a reason to drop the whole notification.
  if (typeof normalized.confidence === "number") {
    normalized.confidence = Math.min(1, Math.max(0, normalized.confidence));
  }
  // `null` is how the model says "no reasoning summary"; our type uses absence.
  if (normalized.reasoningSummary === null || normalized.reasoningSummary === "") {
    delete normalized.reasoningSummary;
  }

  return triageResultSchema.parse(normalized);
}
