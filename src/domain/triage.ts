import type { SupportRequest } from "./supportRequest.js";
import type { TriageResult } from "../triage/schema.js";

export type { TriageResult };

/**
 * The AI boundary. Business logic depends on this interface, never on a vendor
 * SDK, so swapping or adding providers is a one-file change.
 */
export interface TriageProvider {
  classify(request: SupportRequest): Promise<TriageResult>;
}

/** Thrown by providers when a classification could not be produced. */
export class TriageError extends Error {
  override readonly name = "TriageError";
  constructor(
    message: string,
    readonly reason: "provider_error" | "invalid_output" | "refusal" | "timeout" | "not_configured",
  ) {
    super(message);
  }
}
