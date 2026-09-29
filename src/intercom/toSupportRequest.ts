import { MAX_MESSAGE_CHARS, type SupportRequest } from "../domain/supportRequest.js";
import { stripHtml, truncate, unixSecondsToIso } from "../utils/text.js";
import {
  intercomConversationSchema,
  type IntercomContact,
  type IntercomConversation,
  type IntercomConversationPart,
  type IntercomNotification,
} from "./types.js";
import type { SupportedTopic } from "./parseEvent.js";

/**
 * Author types that represent the customer rather than a teammate or a bot.
 * A `conversation.user.replied` payload contains the full part history, so we
 * have to pick the customer's newest part rather than just the last one.
 */
const CUSTOMER_AUTHOR_TYPES = new Set(["user", "lead", "contact", "visitor"]);

/** Author types that represent .box rather than the customer. */
const TEAM_AUTHOR_TYPES = new Set(["admin", "bot", "team"]);

/** Parts that carry customer-authored text. `note`/`assignment` etc. do not. */
const MESSAGE_PART_TYPES = new Set(["comment", "message", "conversation_part"]);

export type NormalizationResult =
  | { kind: "ok"; request: SupportRequest }
  | { kind: "skipped"; reason: "no_customer_message" | "unreadable_item" };

function isCustomerAuthored(part: IntercomConversationPart): boolean {
  const authorType = part.author?.type?.toLowerCase();
  return authorType !== undefined && CUSTOMER_AUTHOR_TYPES.has(authorType);
}

function pickLatestCustomerPart(
  parts: readonly IntercomConversationPart[],
): IntercomConversationPart | undefined {
  const candidates = parts.filter(
    (part) =>
      isCustomerAuthored(part) &&
      typeof part.body === "string" &&
      stripHtml(part.body).length > 0 &&
      (part.part_type === null ||
        part.part_type === undefined ||
        MESSAGE_PART_TYPES.has(part.part_type.toLowerCase())),
  );
  if (candidates.length === 0) return undefined;

  // Prefer the newest by created_at; fall back to document order, which
  // Intercom returns oldest-first.
  return candidates.reduce((newest, current) =>
    (current.created_at ?? 0) >= (newest.created_at ?? 0) ? current : newest,
  );
}

/**
 * When a teammate last replied. Used for sorting - "nobody has answered this
 * yet" is the state worth surfacing, so an absent value is meaningful.
 */
function pickLastResponseAt(parts: readonly IntercomConversationPart[]): string | undefined {
  let newest: number | undefined;
  for (const part of parts) {
    const authorType = part.author?.type?.toLowerCase();
    if (authorType === undefined || !TEAM_AUTHOR_TYPES.has(authorType)) continue;
    // A note or assignment is internal bookkeeping, not a response.
    if (
      part.part_type !== null &&
      part.part_type !== undefined &&
      !MESSAGE_PART_TYPES.has(part.part_type.toLowerCase())
    ) {
      continue;
    }
    if (typeof part.body !== "string" || stripHtml(part.body).length === 0) continue;
    if (typeof part.created_at !== "number") continue;
    if (newest === undefined || part.created_at > newest) newest = part.created_at;
  }
  return unixSecondsToIso(newest);
}

function pickCustomer(
  conversation: IntercomConversation,
  part: IntercomConversationPart | undefined,
): SupportRequest["customer"] {
  // Intercom spreads customer identity across several places and each one may
  // be partial - `contacts[0]` is frequently just an id while `source.author`
  // carries the name and email. Merge in preference order rather than picking
  // one source, so the Slack alert shows the most useful identity available.
  const candidates: Array<IntercomContact | NonNullable<IntercomConversationPart["author"]>> = [];
  if (part?.author) candidates.push(part.author);
  const contacts = conversation.contacts ?? [];
  if (contacts.length > 0 && contacts[0]) candidates.push(contacts[0]);
  if (conversation.source?.author) candidates.push(conversation.source.author);
  if (conversation.user) candidates.push(conversation.user);

  const customer: NonNullable<SupportRequest["customer"]> = {};
  for (const candidate of candidates) {
    if (!customer.id && candidate.id) customer.id = candidate.id;
    if (!customer.email && candidate.email) customer.email = candidate.email;
    if (!customer.name && candidate.name) customer.name = candidate.name;
  }

  return (customer.id ?? customer.email ?? customer.name) ? customer : undefined;
}

function buildIntercomUrl(
  appId: string | null | undefined,
  conversationId: string,
): string | undefined {
  if (!appId) return undefined;
  // Intercom inbox deep link. `app_id` comes from the (signature-verified)
  // webhook envelope, so there is no user-controlled input in this URL.
  if (!/^[A-Za-z0-9_-]+$/.test(appId)) return undefined;
  return `https://app.intercom.com/a/apps/${appId}/conversations/${encodeURIComponent(conversationId)}`;
}

/**
 * Transforms a verified Intercom notification into the internal
 * {@link SupportRequest}. This is the only place that knows Intercom's shape.
 */
export function toSupportRequest(
  notification: IntercomNotification,
  topic: SupportedTopic,
): NormalizationResult {
  const itemResult = intercomConversationSchema.safeParse(notification.data.item);
  if (!itemResult.success) return { kind: "skipped", reason: "unreadable_item" };
  const conversation = itemResult.data;

  const conversationId = conversation.id;
  if (!conversationId) return { kind: "skipped", reason: "unreadable_item" };

  const parts = conversation.conversation_parts ?? [];
  const latestCustomerPart =
    topic === "conversation.user.replied" ? pickLatestCustomerPart(parts) : undefined;

  // For a new conversation the text lives in `source.body`. For a reply we want
  // the newest customer-authored part, falling back to `source.body` if the
  // payload did not include parts.
  const rawBody = latestCustomerPart?.body ?? conversation.source?.body ?? null;
  if (typeof rawBody !== "string") return { kind: "skipped", reason: "no_customer_message" };

  const message = truncate(stripHtml(rawBody), MAX_MESSAGE_CHARS);
  if (message.length === 0) return { kind: "skipped", reason: "no_customer_message" };

  const messageId = latestCustomerPart?.id ?? conversation.source?.id ?? undefined;
  const createdAt =
    unixSecondsToIso(latestCustomerPart?.created_at) ??
    unixSecondsToIso(conversation.updated_at) ??
    unixSecondsToIso(conversation.created_at) ??
    unixSecondsToIso(notification.created_at);

  const request: SupportRequest = {
    eventId: notification.id,
    conversationId,
    message,
  };
  if (messageId) request.messageId = messageId;
  const customer = pickCustomer(conversation, latestCustomerPart);
  if (customer) request.customer = customer;
  if (createdAt) request.createdAt = createdAt;
  const conversationCreatedAt = unixSecondsToIso(conversation.created_at);
  if (conversationCreatedAt) request.conversationCreatedAt = conversationCreatedAt;
  const lastResponseAt = pickLastResponseAt(parts);
  if (lastResponseAt) request.lastResponseAt = lastResponseAt;
  const url = buildIntercomUrl(notification.app_id, conversationId);
  if (url) request.intercomUrl = url;

  return { kind: "ok", request };
}
