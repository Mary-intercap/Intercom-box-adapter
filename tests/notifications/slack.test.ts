import { describe, expect, it, vi } from "vitest";

import { createSlackWebhookNotifier, SlackError } from "../../src/notifications/slack.js";
import type { SlackMessage } from "../../src/notifications/formatting.js";

const WEBHOOK_URL = "https://hooks.slack.com/services/T000/B000/secret-token-value";
const MESSAGE: SlackMessage = { text: "hello", blocks: [{ type: "section" }] };

function notifier(fetchImpl: typeof fetch) {
  return createSlackWebhookNotifier({ webhookUrl: WEBHOOK_URL, timeoutMs: 1000, fetchImpl });
}

describe("slack webhook notifier", () => {
  it("POSTs JSON to the webhook URL", async () => {
    const fetchImpl = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response("ok", { status: 200 })),
    );
    await notifier(fetchImpl as unknown as typeof fetch).notify(MESSAGE);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0];
    if (!call) throw new Error("fetch was not called");
    const [url, init] = call as [string, RequestInit];
    expect(url).toBe(WEBHOOK_URL);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual(MESSAGE);
  });

  it("throws a SlackError carrying status and Slack's error code", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response("invalid_payload", { status: 400 })),
    );
    const error = await notifier(fetchImpl as unknown as typeof fetch)
      .notify(MESSAGE)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SlackError);
    expect(error).toMatchObject({ status: 400, slackCode: "invalid_payload" });
  });

  it("throws on 404 no_service", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response("no_service", { status: 404 })));
    await expect(
      notifier(fetchImpl as unknown as typeof fetch).notify(MESSAGE),
    ).rejects.toBeInstanceOf(SlackError);
  });

  it("throws when the request fails at the transport level", async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new TypeError("network down")));
    await expect(
      notifier(fetchImpl as unknown as typeof fetch).notify(MESSAGE),
    ).rejects.toBeInstanceOf(SlackError);
  });

  it("aborts after the configured timeout", async () => {
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("AbortError")));
      });
    });
    const slow = createSlackWebhookNotifier({
      webhookUrl: WEBHOOK_URL,
      timeoutMs: 10,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(slow.notify(MESSAGE)).rejects.toBeInstanceOf(SlackError);
  });

  it("never puts the webhook URL into an error", async () => {
    const cases: Array<() => Promise<unknown>> = [
      () => Promise.reject(new TypeError(`failed to fetch ${WEBHOOK_URL}`)),
      () => Promise.resolve(new Response("invalid_token", { status: 403 })),
    ];
    for (const impl of cases) {
      const error = await notifier(impl as unknown as typeof fetch)
        .notify(MESSAGE)
        .catch((e: unknown) => e);
      const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
      expect(serialized).not.toContain("secret-token-value");
    }
  });
});
