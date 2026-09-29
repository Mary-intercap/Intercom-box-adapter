import type { SupportRequest } from "../domain/supportRequest.js";
import type { TriageProvider } from "../domain/triage.js";
import type { TriageCategory, TriagePriority, TriageResult } from "./schema.js";
import { toTriageResult } from "./schema.js";
import { truncate } from "../utils/text.js";

/**
 * A deterministic, offline stand-in for the Claude provider.
 *
 * Purpose: let the pipeline and the dashboard be exercised end to end with no
 * API key, no network, and no spend - useful for local development, demos, and
 * tests that care about pipeline behaviour rather than classification quality.
 *
 * This is keyword matching, not classification. It has no understanding of the
 * message and will be confidently wrong on anything subtle. Every result it
 * produces says so in `reasoningSummary`, and the service logs a warning at
 * startup when it is selected, so a mock result can never be mistaken for a
 * real one on the dashboard.
 */

interface CategoryRule {
  category: TriageCategory;
  keywords: readonly string[];
  /**
   * How much each hit counts. Defaults to 1. Raised for markers that are
   * effectively unambiguous - "pipedrive", "centralnic", "easybox" name one
   * specific thing, whereas "renewal" or "error" appear in all sorts of
   * messages. Without this, a Pipedrive notification mentioning "renewal"
   * ties with domain_registration and loses on list order.
   */
  weight?: number;
}

/**
 * Scored, not first-match-wins: every rule is evaluated and the highest hit
 * count decides. A single incidental keyword ("I checked spam") should not
 * outrank three direct ones ("log in", "password", "my account"). Ties break
 * toward the earlier rule, so the list order still encodes severity priority.
 */
const CATEGORY_RULES: readonly CategoryRule[] = [
  {
    category: "security",
    keywords: [
      "hacked",
      "compromis",
      "phish",
      "breach",
      "unauthorized",
      "stolen",
      "2fa",
      "suspicious login",
    ],
  },
  {
    category: "abuse",
    keywords: [
      "abuse",
      "malware",
      "spam",
      "fraud",
      "scam",
      "illegal",
      "report this domain",
      "impersonat",
    ],
  },
  {
    category: "billing",
    keywords: [
      "charg",
      "bill",
      "invoice",
      "refund",
      "payment",
      "card",
      "receipt",
      "subscription",
      "price",
    ],
  },
  {
    category: "domain_registration",
    keywords: [
      "register",
      "registration",
      "transfer",
      "renew",
      "purchase",
      "checkout",
      "order",
      "pending",
    ],
  },
  {
    category: "dns",
    keywords: [
      "dns",
      "resolve",
      "resolving",
      "nameserver",
      "name server",
      "cname",
      "a record",
      "mx",
      "propagat",
      "dnssec",
    ],
  },
  {
    category: "account",
    keywords: [
      "log in",
      "login",
      "sign in",
      "signin",
      "password",
      "locked out",
      "my account",
      "permission",
    ],
  },
  {
    category: "feature_request",
    keywords: [
      "feature request",
      "would be nice",
      "could you add",
      "please add",
      "suggestion",
      "wishlist",
      "support for",
    ],
  },
  {
    category: "technical_issue",
    keywords: [
      "error",
      "broken",
      "not working",
      "doesn't work",
      "bug",
      "crash",
      "500",
      "timeout",
      "fails",
    ],
  },
  {
    category: "general",
    keywords: ["how do i", "how can i", "question", "wondering", "what is", "documentation"],
  },
  {
    category: "misdirected",
    weight: 2,
    keywords: [
      "easybox",
      "easy box",
      "vodafone",
      "telekom",
      "fritzbox",
      "192.168.2.1",
      "aktivierungscode",
      "zugangsdaten",
      "anschluss",
      "wlan",
      "router",
      "dsl",
      "breitband",
      "festnetz",
    ],
  },
  {
    category: "not_support",
    weight: 2,
    keywords: [
      "pipedrive",
      "centralnic",
      "deal stage",
      "activity reminder",
      "out of office",
      "automatic reply",
      "newsletter",
      "unsubscribe",
      "do not reply",
      "no-reply",
    ],
  },
];

const WIDESPREAD = [
  "outage",
  "everyone",
  "all our",
  "all my",
  "multiple",
  "entire",
  "nobody can",
  "company-wide",
];
const BLOCKED = [
  "can't",
  "cannot",
  "unable",
  "down",
  "stopped working",
  "no longer",
  "locked out",
  "stuck",
];

/** Baseline urgency per category, before the message itself is considered. */
const BASE_PRIORITY: Record<TriageCategory, TriagePriority> = {
  security: "critical",
  abuse: "critical",
  billing: "high",
  domain_registration: "medium",
  dns: "medium",
  account: "medium",
  technical_issue: "medium",
  feature_request: "low",
  general: "low",
  not_support: "low",
  misdirected: "low",
  other: "low",
};

/**
 * Standard redirect for people who have reached .box looking for their
 * telephone or internet provider. The real classifier writes this itself, in
 * whichever language the customer used; the mock picks between two fixed
 * versions so the offline demo is representative.
 */
const MISDIRECTED_REPLY_EN =
  "Thanks for getting in touch. You've reached .box, a provider of .box domain names — " +
  "we're not connected with your telephone or internet provider and can't help with " +
  "activation or router setup. Please contact your provider's support directly.";

const MISDIRECTED_REPLY_DE =
  "Hallo,\n\nSie haben den Support von my.box erreicht, einen Anbieter von .box-Domainnamen. " +
  "Wir haben nichts mit Vodafone oder der EasyBox zu tun und können bei der Aktivierung nicht helfen.\n\n" +
  "Bitte wenden Sie sich an den Vodafone-Kundenservice unter 0800 172 1212 oder unter vodafone.de/hilfe.\n\n" +
  "Viele Grüße\n.box Support Team";

const GERMAN_MARKERS = [
  "ich ",
  "nicht",
  "bitte",
  "hallo",
  "mein",
  "kann",
  "funktioniert",
  "danke",
  "wie ",
  "und ",
];

const SUGGESTED: Record<TriageCategory, string> = {
  dns: "Thanks for reporting this. We'll check the DNS status for your domain and come back to you shortly.",
  domain_registration:
    "Thanks for getting in touch. We'll look into the status of that registration and update you.",
  billing:
    "Thanks for flagging this. We'll review the charges on your account and get back to you.",
  account: "Thanks for reaching out. We'll look into the access issue on your account.",
  technical_issue:
    "Thanks for the report. We'll investigate what's behind that error and follow up.",
  feature_request: "Thanks for the suggestion — we'll pass it on to the team.",
  security:
    "Thanks for reporting this. We're treating it as urgent and someone will be in touch shortly.",
  abuse: "Thanks for the report. Our abuse team will review this.",
  general: "Thanks for getting in touch — we'll come back to you with an answer shortly.",
  not_support: "No reply needed — this is not a customer support request.",
  misdirected: MISDIRECTED_REPLY_EN,
  other: "Thanks for getting in touch. We'll take a look and follow up.",
};

const PRIORITY_ORDER: readonly TriagePriority[] = ["low", "medium", "high", "critical"];

function raise(priority: TriagePriority, steps: number): TriagePriority {
  const index = PRIORITY_ORDER.indexOf(priority);
  return PRIORITY_ORDER[Math.min(PRIORITY_ORDER.length - 1, index + steps)] ?? priority;
}

function firstSentence(message: string): string {
  const match = /^(.*?[.!?])(\s|$)/s.exec(message.trim());
  return truncate((match?.[1] ?? message).trim().replace(/\s+/g, " "), 180);
}

export function classifyWithKeywords(message: string): TriageResult {
  const text = message.toLowerCase();

  let category: TriageCategory = "other";
  let matched: string[] = [];
  let bestScore = 0;
  for (const rule of CATEGORY_RULES) {
    const hits = rule.keywords.filter((keyword) => text.includes(keyword));
    const score = hits.length * (rule.weight ?? 1);
    if (score > bestScore) {
      bestScore = score;
      category = rule.category;
      matched = hits;
    }
  }

  const widespread = WIDESPREAD.filter((k) => text.includes(k));
  const blocked = BLOCKED.filter((k) => text.includes(k));

  let priority = BASE_PRIORITY[category];
  if (widespread.length > 0) priority = raise(priority, 2);
  else if (blocked.length > 0) priority = raise(priority, 1);

  // A misdirected human is still waiting on a one-line redirect, so it needs a
  // person even at low priority. Automated vendor mail needs nobody.
  const actionRequired =
    category === "not_support" ? false : priority !== "low" || category === "misdirected";

  // Deterministic, and honest about being weak: keyword matching on a short
  // message deserves low confidence.
  const confidence = Math.min(0.75, 0.35 + matched.length * 0.1 + (blocked.length > 0 ? 0.05 : 0));

  const signals = [...matched, ...widespread, ...blocked];

  return toTriageResult({
    category,
    priority,
    actionRequired,
    confidence,
    summary: `The customer reports: ${firstSentence(message)}`,
    suggestedResponse:
      category === "misdirected" && GERMAN_MARKERS.some((marker) => text.includes(marker))
        ? MISDIRECTED_REPLY_DE
        : SUGGESTED[category],
    reasoningSummary: `MOCK CLASSIFIER (no AI was called) — matched ${
      signals.length > 0
        ? `on: ${signals.slice(0, 6).join(", ")}`
        : "nothing; defaulted to other/low"
    }.`,
  });
}

export function createMockTriageProvider(): TriageProvider {
  return {
    classify(request: SupportRequest): Promise<TriageResult> {
      return Promise.resolve(classifyWithKeywords(request.message));
    },
  };
}
