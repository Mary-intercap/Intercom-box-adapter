import type { SlackMessage } from "./formatting.js";

/**
 * Slack delivery via an Incoming Webhook.
 *
 * An Incoming Webhook is a plain `POST` of JSON to a secret URL - no bot token,
 * no OAuth, no Slack app scopes to manage. Slack answers `200` with the body
 * `ok`, or a 4xx with a short error code such as `invalid_payload` or
 * `no_service`.
 *
 * Docs: https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/
 */

export interface SlackNotifier {
  notify(message: SlackMessage): Promise<void>;
}

export class SlackError extends Error {
  override readonly name = "SlackError";
  constructor(
    message: string,
    readonly status?: number,
    /** Slack's own error code, e.g. `invalid_payload`. Safe to log. */
    readonly slackCode?: string,
  ) {
    super(message);
  }
}

export interface SlackWebhookOptions {
  webhookUrl: string;
  timeoutMs: number;
  /** Injection seam for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export function createSlackWebhookNotifier(options: SlackWebhookOptions): SlackNotifier {
  const doFetch = options.fetchImpl ?? globalThis.fetch;

  return {
    async notify(message: SlackMessage): Promise<void> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs);

      let response: Response;
      try {
        response = await doFetch(options.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(message),
          signal: controller.signal,
        });
      } catch (error) {
        // The webhook URL is a credential - it must never reach an error
        // message, a log line, or an exception that gets serialised upstream.
        const cause = error instanceof Error ? error.name : "UnknownError";
        throw new SlackError(`slack request failed (${cause})`);
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const slackCode = body.trim().slice(0, 100) || undefined;
        throw new SlackError(
          `slack returned HTTP ${String(response.status)}`,
          response.status,
          slackCode,
        );
      }
    },
  };
}
