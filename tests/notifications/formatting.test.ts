import { describe, expect, it } from "vitest";

import { buildDegradedMessage, buildTriageMessage } from "../../src/notifications/formatting.js";
import type { SupportRequest } from "../../src/domain/supportRequest.js";
import { sampleSupportRequest, sampleTriageResult } from "../fixtures/deps.js";

function textOf(blocks: unknown[]): string {
  return JSON.stringify(blocks);
}

describe("buildTriageMessage", () => {
  const message = buildTriageMessage(sampleSupportRequest, sampleTriageResult);
  const rendered = textOf(message.blocks);

  it("shows priority in the header and the fallback text", () => {
    expect(message.blocks[0]).toMatchObject({
      type: "header",
      text: { type: "plain_text", text: expect.stringContaining("Intercom Support — HIGH") },
    });
    expect(message.text).toContain("HIGH");
  });

  it("shows category, priority, AI assessment and confidence", () => {
    expect(rendered).toContain("DNS");
    expect(rendered).toContain("HIGH");
    expect(rendered).toContain("Human attention required");
    expect(rendered).toContain("92%");
  });

  it("shows the customer, the message, the summary and the suggested response", () => {
    expect(rendered).toContain("customer@example.com");
    expect(rendered).toContain("stopped resolving this morning");
    expect(rendered).toContain("The customer reports");
    expect(rendered).toContain("Suggested response");
    expect(rendered).toContain("We'll take a look at the DNS status");
  });

  it("labels AI content as AI-generated and unverified", () => {
    expect(rendered).toContain("AI summary");
    expect(rendered).toContain("AI-generated");
    expect(rendered).toContain("not verified facts");
    expect(rendered).toContain("Nothing has been sent to the customer");
  });

  it("marks the suggested response as a draft that was not sent", () => {
    expect(rendered).toContain("AI draft — not sent");
  });

  it("links to the Intercom conversation", () => {
    expect(rendered).toContain("Open conversation in Intercom");
    expect(rendered).toContain(sampleSupportRequest.intercomUrl);
  });

  it("omits the link block when no Intercom URL is known", () => {
    const withoutUrl: SupportRequest = { ...sampleSupportRequest };
    delete withoutUrl.intercomUrl;
    const built = buildTriageMessage(withoutUrl, sampleTriageResult);
    expect(textOf(built.blocks)).not.toContain("Open conversation in Intercom");
  });

  it("includes the reasoning summary only when present", () => {
    expect(rendered).toContain("AI reasoning");
    const noReasoning = { ...sampleTriageResult };
    delete noReasoning.reasoningSummary;
    expect(textOf(buildTriageMessage(sampleSupportRequest, noReasoning).blocks)).not.toContain(
      "AI reasoning",
    );
  });

  it("falls back gracefully when the customer is unidentified", () => {
    const anonymous: SupportRequest = { ...sampleSupportRequest };
    delete anonymous.customer;
    expect(textOf(buildTriageMessage(anonymous, sampleTriageResult).blocks)).toContain(
      "_unidentified_",
    );
  });

  it("escapes Slack mrkdwn control characters in customer text", () => {
    const hostile: SupportRequest = {
      ...sampleSupportRequest,
      message: "<https://evil.example|click here> & <!channel>",
    };
    const built = textOf(buildTriageMessage(hostile, sampleTriageResult).blocks);
    expect(built).toContain("&lt;https://evil.example|click here&gt;");
    expect(built).toContain("&lt;!channel&gt;");
    expect(built).not.toContain("<!channel>");
  });

  it("stays inside Slack block length limits for a very long message", () => {
    const long: SupportRequest = { ...sampleSupportRequest, message: "word ".repeat(2000) };
    const built = buildTriageMessage(long, sampleTriageResult);
    for (const block of built.blocks as { text?: { text?: string } }[]) {
      if (block.text?.text) expect(block.text.text.length).toBeLessThanOrEqual(3000);
    }
  });

  it("renders every priority", () => {
    for (const priority of ["low", "medium", "high", "critical"] as const) {
      const built = buildTriageMessage(sampleSupportRequest, { ...sampleTriageResult, priority });
      expect(built.text).toContain(priority.toUpperCase());
    }
  });
});

describe("buildDegradedMessage", () => {
  it("marks the notification unclassified and explains why", () => {
    const built = buildDegradedMessage(sampleSupportRequest, "provider_error");
    const rendered = textOf(built.blocks);
    expect(built.text).toContain("UNCLASSIFIED");
    expect(rendered).toContain("AI triage unavailable");
    expect(rendered).toContain("The AI provider returned an error.");
    expect(rendered).toContain("please review it manually");
  });

  it("still carries the customer message and the Intercom link", () => {
    const rendered = textOf(buildDegradedMessage(sampleSupportRequest, "timeout").blocks);
    expect(rendered).toContain("stopped resolving this morning");
    expect(rendered).toContain("Open conversation in Intercom");
  });

  it("never implies a classification was made", () => {
    for (const reason of [
      "provider_error",
      "invalid_output",
      "refusal",
      "timeout",
      "not_configured",
    ] as const) {
      const rendered = textOf(buildDegradedMessage(sampleSupportRequest, reason).blocks);
      expect(rendered).toContain("No AI classification was produced");
      expect(rendered).not.toContain("AI summary");
    }
  });
});
