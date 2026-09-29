import { describe, expect, it } from "vitest";

import { parseIntercomEvent, SUPPORTED_TOPICS } from "../../src/intercom/parseEvent.js";
import { toSupportRequest } from "../../src/intercom/toSupportRequest.js";
import { MAX_MESSAGE_CHARS } from "../../src/domain/supportRequest.js";
import {
  conversationCreatedPayload,
  conversationRepliedPayload,
  unsupportedTopicPayload,
} from "../fixtures/intercom.js";

function normalize(payload: unknown) {
  const parsed = parseIntercomEvent(payload);
  if (parsed.kind !== "accepted") throw new Error(`expected accepted, got ${parsed.kind}`);
  return toSupportRequest(parsed.notification, parsed.topic);
}

describe("parseIntercomEvent", () => {
  it("accepts both supported topics", () => {
    expect(SUPPORTED_TOPICS).toEqual(["conversation.user.created", "conversation.user.replied"]);
    expect(parseIntercomEvent(conversationCreatedPayload()).kind).toBe("accepted");
    expect(parseIntercomEvent(conversationRepliedPayload()).kind).toBe("accepted");
  });

  it("ignores unrelated topics instead of failing", () => {
    expect(parseIntercomEvent(unsupportedTopicPayload())).toEqual({
      kind: "ignored",
      reason: "unsupported_topic",
      topic: "contact.created",
    });
  });

  it("rejects an envelope with no event id", () => {
    const payload = conversationCreatedPayload();
    delete (payload as Record<string, unknown>).id;
    expect(parseIntercomEvent(payload).kind).toBe("invalid");
  });

  it("rejects non-object payloads without throwing", () => {
    for (const payload of [null, "a string", 42, [], undefined]) {
      expect(parseIntercomEvent(payload).kind).toBe("invalid");
    }
  });
});

describe("toSupportRequest", () => {
  it("normalizes a conversation.user.created event", () => {
    const result = normalize(conversationCreatedPayload());
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;

    expect(result.request).toEqual({
      eventId: "notif_created_001",
      conversationId: "conv_5001",
      messageId: "msg_9001",
      message: "My .box domain stopped resolving this morning.",
      customer: { id: "contact_777", name: "Alex Rivera", email: "customer@example.com" },
      createdAt: "2023-11-14T22:13:15.000Z",
      conversationCreatedAt: "2023-11-14T22:13:10.000Z",
      intercomUrl: "https://app.intercom.com/a/apps/abc12345/conversations/conv_5001",
    });
  });

  it("picks the newest customer-authored part for a reply, not the newest part", () => {
    const result = normalize(conversationRepliedPayload());
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;

    // part_3 is newer but authored by an admin; part_1 is an admin comment.
    expect(result.request.messageId).toBe("part_2");
    expect(result.request.message).toBe("It is still failing.\nThe domain is example.box");
    expect(result.request.customer?.email).toBe("customer@example.com");
  });

  it("captures the three timestamps separately on a reply", () => {
    const result = normalize(conversationRepliedPayload());
    if (result.kind !== "ok") throw new Error("expected ok");

    // The conversation opened before the reply arrived.
    expect(result.request.conversationCreatedAt).toBe("2023-11-14T22:13:10.000Z");
    // The customer's own latest message (part_2).
    expect(result.request.createdAt).toBe("2023-11-14T22:18:20.000Z");
    // The admin comment (part_1) is the last thing .box said.
    expect(result.request.lastResponseAt).toBe("2023-11-14T22:15:00.000Z");
  });

  it("leaves lastResponseAt absent when nobody from .box has replied", () => {
    const result = normalize(conversationCreatedPayload());
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.request.lastResponseAt).toBeUndefined();
  });

  it("does not count internal notes or assignments as a response", () => {
    const payload = conversationRepliedPayload();
    const item = (payload.data as { item: Record<string, unknown> }).item;
    item.conversation_parts = {
      type: "conversation_part.list",
      conversation_parts: [
        {
          id: "p1",
          part_type: "note",
          body: "<p>internal note, not a reply to the customer</p>",
          created_at: 1_700_000_350,
          author: { type: "admin", id: "admin_1" },
        },
        {
          id: "p2",
          part_type: "assignment",
          body: null,
          created_at: 1_700_000_360,
          author: { type: "admin", id: "admin_1" },
        },
        {
          id: "p3",
          part_type: "comment",
          body: "<p>still broken</p>",
          created_at: 1_700_000_300,
          author: { type: "user", id: "contact_777" },
        },
      ],
    };
    const result = normalize(payload);
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.request.lastResponseAt).toBeUndefined();
  });

  it("strips HTML and decodes entities", () => {
    const payload = conversationCreatedPayload();
    const item = (payload.data as { item: Record<string, unknown> }).item;
    (item.source as Record<string, unknown>).body =
      "<div>DNS &amp; TLS <b>broken</b><br>since &#8220;Tuesday&#8221;</div>";
    const result = normalize(payload);
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.request.message).toBe("DNS & TLS broken\nsince “Tuesday”");
  });

  it("truncates very long messages", () => {
    const payload = conversationCreatedPayload();
    const item = (payload.data as { item: Record<string, unknown> }).item;
    (item.source as Record<string, unknown>).body = "x".repeat(MAX_MESSAGE_CHARS * 2);
    const result = normalize(payload);
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.request.message).toHaveLength(MAX_MESSAGE_CHARS);
  });

  it("survives a payload with no customer information", () => {
    const payload = conversationCreatedPayload();
    const item = (payload.data as { item: Record<string, unknown> }).item;
    delete item.contacts;
    delete (item.source as Record<string, unknown>).author;
    const result = normalize(payload);
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.request.customer).toBeUndefined();
    expect(result.request.message).toContain("stopped resolving");
  });

  it("accepts the bare-array form of contacts and conversation_parts", () => {
    const payload = conversationRepliedPayload();
    const item = (payload.data as { item: Record<string, unknown> }).item;
    item.contacts = [{ type: "contact", id: "contact_777", email: "legacy@example.com" }];
    item.conversation_parts = [
      {
        id: "part_legacy",
        part_type: "comment",
        body: "<p>legacy shape</p>",
        created_at: 1_700_000_300,
        author: { type: "user", id: "contact_777" },
      },
    ];
    const result = normalize(payload);
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.request.message).toBe("legacy shape");
    expect(result.request.messageId).toBe("part_legacy");
  });

  it("skips an event with no usable message text", () => {
    const payload = conversationCreatedPayload();
    const item = (payload.data as { item: Record<string, unknown> }).item;
    (item.source as Record<string, unknown>).body = "<p>   </p>";
    expect(normalize(payload)).toEqual({ kind: "skipped", reason: "no_customer_message" });
  });

  it("skips an item that is not a readable conversation", () => {
    const payload = conversationCreatedPayload();
    (payload.data as Record<string, unknown>).item = "not an object";
    expect(normalize(payload)).toEqual({ kind: "skipped", reason: "unreadable_item" });
  });

  it("omits the Intercom URL when app_id is absent or unsafe", () => {
    for (const appId of [undefined, "../../evil", "app id with spaces"]) {
      const payload = conversationCreatedPayload();
      if (appId === undefined) delete (payload as Record<string, unknown>).app_id;
      else (payload as Record<string, unknown>).app_id = appId;
      const result = normalize(payload);
      if (result.kind !== "ok") throw new Error("expected ok");
      expect(result.request.intercomUrl).toBeUndefined();
    }
  });
});
