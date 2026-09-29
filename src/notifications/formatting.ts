import type { SupportRequest } from "../domain/supportRequest.js";
import type { DegradedReason } from "../domain/triageRecord.js";
import type { TriageResult } from "../triage/schema.js";
import { truncate } from "../utils/text.js";

/**
 * Slack Block Kit payload construction. Pure functions - no network, no config -
 * so the wording and layout are cheap to test and cheap to change.
 *
 * Block Kit reference: https://docs.slack.dev/block-kit/
 */

export interface SlackMessage {
  /** Plain-text fallback shown in notifications and by clients without blocks. */
  text: string;
  blocks: unknown[];
}

/** Slack limits: header plain_text 150 chars, section text 3000 chars. */
const HEADER_LIMIT = 150;
const SECTION_LIMIT = 2800;
const MESSAGE_LIMIT = 1500;

const PRIORITY_ICON: Record<TriageResult["priority"], string> = {
  critical: ":red_circle:",
  high: ":large_orange_circle:",
  medium: ":large_yellow_circle:",
  low: ":large_green_circle:",
};

const CATEGORY_LABEL: Record<TriageResult["category"], string> = {
  dns: "DNS",
  domain_registration: "Domain registration",
  billing: "Billing",
  account: "Account",
  technical_issue: "Technical issue",
  feature_request: "Feature request",
  security: "Security",
  abuse: "Abuse",
  general: "General",
  not_support: "Not a support request",
  misdirected: "Misdirected — wrong company",
  other: "Other",
};

const AI_DISCLAIMER =
  ":robot_face: Category, priority, summary, assessment and suggested response are AI-generated from the customer's message alone. They are *not verified facts* and no system has been checked. Nothing has been sent to the customer.";

/** Slack mrkdwn treats &, < and > structurally; escape them in untrusted text. */
function escapeMrkdwn(input: string): string {
  return input.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function section(text: string): Record<string, unknown> {
  return { type: "section", text: { type: "mrkdwn", text: truncate(text, SECTION_LIMIT) } };
}

function quote(text: string): string {
  return escapeMrkdwn(text)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function customerLine(request: SupportRequest): string {
  const customer = request.customer;
  const identity = customer?.email ?? customer?.name ?? customer?.id;
  return identity ? escapeMrkdwn(identity) : "_unidentified_";
}

function linkBlock(request: SupportRequest): Record<string, unknown> | null {
  if (!request.intercomUrl) return null;
  return {
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Open conversation in Intercom", emoji: true },
        url: request.intercomUrl,
        action_id: "open_intercom_conversation",
      },
    ],
  };
}

/** The V1 notification: every valid support request produces one of these. */
export function buildTriageMessage(request: SupportRequest, result: TriageResult): SlackMessage {
  const priorityLabel = result.priority.toUpperCase();
  const headerText = truncate(
    `${PRIORITY_ICON[result.priority]} Intercom Support — ${priorityLabel}`,
    HEADER_LIMIT,
  );

  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: headerText, emoji: true } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Category*\n${CATEGORY_LABEL[result.category]}` },
        { type: "mrkdwn", text: `*Priority*\n${priorityLabel}` },
        {
          type: "mrkdwn",
          text: `*AI assessment*\n${result.actionRequired ? "Human attention required" : "No action appears required"}`,
        },
        {
          type: "mrkdwn",
          text: `*AI confidence*\n${Math.round(result.confidence * 100)}%`,
        },
      ],
    },
    section(`*Customer*\n${customerLine(request)}`),
    section(`*Message*\n${quote(truncate(request.message, MESSAGE_LIMIT))}`),
    section(`*AI summary*\n${escapeMrkdwn(result.summary)}`),
  ];

  if (result.reasoningSummary) {
    blocks.push(section(`*AI reasoning*\n${escapeMrkdwn(result.reasoningSummary)}`));
  }

  blocks.push(
    section(`*Suggested response (AI draft — not sent)*\n${quote(result.suggestedResponse)}`),
  );

  const link = linkBlock(request);
  if (link) blocks.push(link);

  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: AI_DISCLAIMER }],
  });

  return {
    text: `Intercom Support — ${priorityLabel} — ${CATEGORY_LABEL[result.category]}: ${truncate(result.summary, 200)}`,
    blocks,
  };
}

const DEGRADED_EXPLANATION: Record<DegradedReason, string> = {
  provider_error: "The AI provider returned an error.",
  invalid_output: "The AI returned output that failed validation.",
  refusal: "The AI declined to classify this message.",
  timeout: "The AI request timed out.",
  not_configured: "No AI provider is configured.",
};

/**
 * Sent when triage fails. V1 must never silently drop a customer request, so a
 * classification failure downgrades the notification rather than cancelling it.
 */
export function buildDegradedMessage(
  request: SupportRequest,
  reason: DegradedReason,
): SlackMessage {
  const blocks: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: ":warning: Intercom Support — UNCLASSIFIED",
        emoji: true,
      },
    },
    section(
      `*AI triage unavailable*\n${DEGRADED_EXPLANATION[reason]} This message has *not* been classified — please review it manually.`,
    ),
    section(`*Customer*\n${customerLine(request)}`),
    section(`*Message*\n${quote(truncate(request.message, MESSAGE_LIMIT))}`),
  ];

  const link = linkBlock(request);
  if (link) blocks.push(link);

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `:robot_face: No AI classification was produced (\`${reason}\`). Nothing has been sent to the customer.`,
      },
    ],
  });

  return {
    text: `Intercom Support — UNCLASSIFIED — AI triage unavailable (${reason})`,
    blocks,
  };
}
