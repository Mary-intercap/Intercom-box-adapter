import { intercomNotificationSchema, type IntercomNotification } from "./types.js";

/**
 * Webhook topics this service acts on. Everything else is acknowledged and
 * dropped - subscribing to an extra topic in the Intercom dashboard must never
 * be able to break the service.
 *
 * Both topics require only the "Read conversations" permission.
 *   conversation.user.created - contact-initiated conversations (User and Lead)
 *   conversation.user.replied - contact replies (Visitor, Lead and User)
 * https://developers.intercom.com/docs/references/webhooks/webhook-models
 */
export const SUPPORTED_TOPICS = ["conversation.user.created", "conversation.user.replied"] as const;

export type SupportedTopic = (typeof SUPPORTED_TOPICS)[number];

function isSupportedTopic(topic: string): topic is SupportedTopic {
  return (SUPPORTED_TOPICS as readonly string[]).includes(topic);
}

export type ParsedEvent =
  | { kind: "accepted"; topic: SupportedTopic; notification: IntercomNotification }
  | { kind: "ignored"; reason: "unsupported_topic"; topic: string }
  | { kind: "invalid"; reason: "schema_mismatch"; detail: string };

/**
 * Validates an already-JSON-parsed webhook body and decides whether we care.
 *
 * Called only after the signature has been verified.
 */
export function parseIntercomEvent(payload: unknown): ParsedEvent {
  const parsed = intercomNotificationSchema.safeParse(payload);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
      .join("; ");
    return { kind: "invalid", reason: "schema_mismatch", detail };
  }

  const notification = parsed.data;
  if (!isSupportedTopic(notification.topic)) {
    return { kind: "ignored", reason: "unsupported_topic", topic: notification.topic };
  }

  return { kind: "accepted", topic: notification.topic, notification };
}
