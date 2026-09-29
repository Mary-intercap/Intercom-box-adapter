/**
 * The internal representation of an inbound customer support request.
 *
 * Nothing downstream of the Intercom adapter is allowed to depend on Intercom's
 * raw payload shape. Adding another intake channel later means writing another
 * adapter that produces this type - nothing else changes.
 */
export type SupportRequest = {
  /** Intercom notification event id. The idempotency key for this pipeline. */
  eventId: string;
  conversationId: string;
  /** Id of the specific message/part the text came from, when identifiable. */
  messageId?: string;

  /** Plain text. HTML-stripped and length-capped by the adapter. */
  message: string;

  customer?: {
    id?: string;
    email?: string;
    name?: string;
  };

  /**
   * ISO-8601. When the message we are triaging was sent. For a reply this is
   * the reply's timestamp, not the conversation's.
   */
  createdAt?: string;

  /** ISO-8601. When the conversation itself was opened. */
  conversationCreatedAt?: string;

  /**
   * ISO-8601. When a teammate last replied, if ever. Absent means nobody from
   * .box has answered this conversation yet - which is usually the interesting
   * case to sort by.
   */
  lastResponseAt?: string;

  intercomUrl?: string;
};

/** Upper bound on message text handed to the model, in characters. */
export const MAX_MESSAGE_CHARS = 4000;
