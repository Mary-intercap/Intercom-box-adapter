import { z } from "zod";

/**
 * Runtime schemas for Intercom webhook payloads.
 *
 * Intercom publishes the notification *envelope* (`type`, `id`, `topic`,
 * `app_id`, `created_at`, `data.item`) but does not publish a complete example
 * of `data.item` for conversation topics, and the shape differs between API
 * versions (e.g. `contacts` is a bare array in older versions and a
 * `{type: "contact.list", contacts: [...]}` wrapper in 2.x).
 *
 * So: the envelope is validated strictly enough to be useful, and the item is
 * validated permissively - `looseObject` keeps unknown fields, and every field
 * inside the conversation is optional. An unexpected shape must degrade to "we
 * could not find the message text", never to a 500. Extraction logic lives in
 * `toSupportRequest.ts`.
 *
 * Reference: https://developers.intercom.com/docs/references/webhooks/webhook-models
 */

/** Intercom ids arrive as strings, but some legacy fields are numeric. */
const intercomId = z.union([z.string(), z.number()]).transform((value) => String(value));

export const intercomAuthorSchema = z.looseObject({
  type: z.string().nullish(),
  id: intercomId.nullish(),
  name: z.string().nullish(),
  email: z.string().nullish(),
});

export const intercomContactSchema = z.looseObject({
  type: z.string().nullish(),
  id: intercomId.nullish(),
  name: z.string().nullish(),
  email: z.string().nullish(),
});

export const intercomConversationPartSchema = z.looseObject({
  id: intercomId.nullish(),
  part_type: z.string().nullish(),
  body: z.string().nullish(),
  created_at: z.number().nullish(),
  author: intercomAuthorSchema.nullish(),
});

/** Accepts both the bare-array form and the `{ <key>: [...] }` wrapper form. */
function listOf<T extends z.ZodType>(item: T, key: string): z.ZodType<z.infer<T>[]> {
  const wrapper = z
    .looseObject({ [key]: z.array(item).nullish() })
    .transform((value) => (value as Record<string, unknown>)[key] ?? []);

  return z
    .union([z.array(item), wrapper])
    .transform((value) => (Array.isArray(value) ? (value as z.infer<T>[]) : []));
}

export const intercomConversationSchema = z.looseObject({
  type: z.string().nullish(),
  id: intercomId.nullish(),
  created_at: z.number().nullish(),
  updated_at: z.number().nullish(),
  source: z
    .looseObject({
      id: intercomId.nullish(),
      type: z.string().nullish(),
      delivered_as: z.string().nullish(),
      subject: z.string().nullish(),
      body: z.string().nullish(),
      author: intercomAuthorSchema.nullish(),
    })
    .nullish(),
  contacts: listOf(intercomContactSchema, "contacts").nullish(),
  /** Older payloads put the contact here instead of in `contacts`. */
  user: intercomContactSchema.nullish(),
  conversation_parts: listOf(intercomConversationPartSchema, "conversation_parts").nullish(),
});

export const intercomNotificationSchema = z.looseObject({
  type: z.string().nullish(),
  /** The idempotency key. Required - without it we cannot deduplicate. */
  id: z.string().min(1),
  topic: z.string().min(1),
  app_id: z.string().nullish(),
  created_at: z.number().nullish(),
  delivery_attempts: z.number().nullish(),
  data: z.looseObject({
    type: z.string().nullish(),
    item: z.unknown(),
  }),
});

export type IntercomNotification = z.infer<typeof intercomNotificationSchema>;
export type IntercomConversation = z.infer<typeof intercomConversationSchema>;
export type IntercomConversationPart = z.infer<typeof intercomConversationPartSchema>;
export type IntercomContact = z.infer<typeof intercomContactSchema>;
