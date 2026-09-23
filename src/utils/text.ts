/** Small text helpers shared by the Intercom adapter and the Slack formatter. */

const NAMED_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

/**
 * Intercom delivers message bodies as HTML. We only ever treat the result as
 * text - it is never rendered, evaluated, or passed to a shell - so a simple
 * tag strip is sufficient and avoids pulling in a parser dependency.
 */
export function stripHtml(input: string): string {
  return input
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&#(\d+);/g, (_match, code: string) => {
      const point = Number.parseInt(code, 10);
      return Number.isFinite(point) && point > 0 && point < 0x110000
        ? String.fromCodePoint(point)
        : "";
    })
    .replace(/&[a-z]+;|&#39;/gi, (entity) => NAMED_ENTITIES[entity.toLowerCase()] ?? entity)
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

export function truncate(input: string, maxLength: number, suffix = "…"): string {
  if (input.length <= maxLength) return input;
  return input.slice(0, Math.max(0, maxLength - suffix.length)) + suffix;
}

/** Converts a Unix-seconds timestamp to an ISO string, or undefined if unusable. */
export function unixSecondsToIso(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
