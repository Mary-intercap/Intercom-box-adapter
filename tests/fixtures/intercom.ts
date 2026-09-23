import { signPayload } from "../../src/intercom/verifySignature.js";

export const TEST_CLIENT_SECRET = "test-client-secret-not-a-real-credential";
export const TEST_APP_ID = "abc12345";

/**
 * Representative `conversation.user.created` payload.
 *
 * Intercom does not publish a complete conversation example, so these fixtures
 * are built from the documented envelope plus the conversation shape returned
 * by the Conversations API (2.x): `contacts` wrapped in a `contact.list`,
 * `source.body` as HTML, `conversation_parts` wrapped in a
 * `conversation_part.list`.
 */
export function conversationCreatedPayload(overrides: Record<string, unknown> = {}) {
  return {
    type: "notification_event",
    app_id: TEST_APP_ID,
    id: "notif_created_001",
    topic: "conversation.user.created",
    created_at: 1_700_000_000,
    delivery_attempts: 1,
    data: {
      type: "notification_event_data",
      item: {
        type: "conversation",
        id: "conv_5001",
        created_at: 1_699_999_990,
        updated_at: 1_699_999_995,
        source: {
          type: "conversation",
          id: "msg_9001",
          delivered_as: "customer_initiated",
          subject: "",
          body: "<p>My .box domain stopped resolving this morning.</p>",
          author: {
            type: "user",
            id: "contact_777",
            name: "Alex Rivera",
            email: "customer@example.com",
          },
        },
        contacts: {
          type: "contact.list",
          contacts: [{ type: "contact", id: "contact_777" }],
        },
        conversation_parts: {
          type: "conversation_part.list",
          conversation_parts: [],
        },
      },
    },
    ...overrides,
  };
}

/** Representative `conversation.user.replied` payload with a part history. */
export function conversationRepliedPayload(overrides: Record<string, unknown> = {}) {
  return {
    type: "notification_event",
    app_id: TEST_APP_ID,
    id: "notif_replied_002",
    topic: "conversation.user.replied",
    created_at: 1_700_000_500,
    data: {
      type: "notification_event_data",
      item: {
        type: "conversation",
        id: "conv_5001",
        created_at: 1_699_999_990,
        updated_at: 1_700_000_400,
        source: {
          type: "conversation",
          id: "msg_9001",
          body: "<p>My .box domain stopped resolving this morning.</p>",
          author: { type: "user", id: "contact_777", email: "customer@example.com" },
        },
        contacts: {
          type: "contact.list",
          contacts: [
            {
              type: "contact",
              id: "contact_777",
              name: "Alex Rivera",
              email: "customer@example.com",
            },
          ],
        },
        conversation_parts: {
          type: "conversation_part.list",
          conversation_parts: [
            {
              id: "part_1",
              part_type: "comment",
              body: "<p>Thanks for reporting this, we are looking into it.</p>",
              created_at: 1_700_000_100,
              author: { type: "admin", id: "admin_1", name: "Support" },
            },
            {
              id: "part_2",
              part_type: "comment",
              body: "<p>It is still failing.<br>The domain is example.box</p>",
              created_at: 1_700_000_300,
              author: { type: "user", id: "contact_777", email: "customer@example.com" },
            },
            {
              id: "part_3",
              part_type: "assignment",
              body: null,
              created_at: 1_700_000_400,
              author: { type: "admin", id: "admin_1" },
            },
          ],
        },
      },
    },
    ...overrides,
  };
}

export function unsupportedTopicPayload() {
  return {
    type: "notification_event",
    app_id: TEST_APP_ID,
    id: "notif_other_003",
    topic: "contact.created",
    created_at: 1_700_000_000,
    data: { type: "notification_event_data", item: { type: "contact", id: "contact_1" } },
  };
}

export interface SignedRequest {
  body: string;
  headers: Record<string, string>;
}

/** Builds a request signed exactly the way Intercom signs one. */
export function signedRequest(
  payload: unknown,
  secret: string = TEST_CLIENT_SECRET,
): SignedRequest {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return {
    body,
    headers: {
      "content-type": "application/json",
      "x-hub-signature": signPayload(body, secret),
    },
  };
}
