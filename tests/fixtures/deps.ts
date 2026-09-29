import { vi } from "vitest";

import type { AppDeps } from "../../src/app.js";
import { createDashboardSink } from "../../src/dashboard/sink.js";
import { createMemoryRecordStore, type TriageRecordStore } from "../../src/dashboard/store.js";
import type { SupportRequest } from "../../src/domain/supportRequest.js";
import type { TriageProvider } from "../../src/domain/triage.js";
import type { NotificationSink, TriageRecord } from "../../src/domain/triageRecord.js";
import { createFanOutSink } from "../../src/notifications/fanOut.js";
import type { SlackMessage } from "../../src/notifications/formatting.js";
import type { SlackNotifier } from "../../src/notifications/slack.js";
import { awaitingDefer } from "../../src/runtime.js";
import { createMemoryEventStore } from "../../src/store/memoryEventStore.js";
import type { TriageResult } from "../../src/triage/schema.js";
import { createLogger, type LogFields, type Logger } from "../../src/utils/logger.js";
import { TEST_CLIENT_SECRET } from "./intercom.js";

export const sampleTriageResult: TriageResult = {
  category: "dns",
  priority: "high",
  actionRequired: true,
  confidence: 0.92,
  summary: "The customer reports that their .box domain stopped resolving this morning.",
  suggestedResponse: "Thanks for reporting this. We'll take a look at the DNS status.",
  reasoningSummary: "Reported loss of resolution for a paid domain.",
};

export const sampleSupportRequest: SupportRequest = {
  eventId: "notif_created_001",
  conversationId: "conv_5001",
  messageId: "msg_9001",
  message: "My .box domain stopped resolving this morning.",
  customer: { id: "contact_777", email: "customer@example.com", name: "Alex Rivera" },
  createdAt: "2023-11-14T22:13:15.000Z",
  intercomUrl: "https://app.intercom.com/a/apps/abc12345/conversations/conv_5001",
};

export function sampleRecord(overrides: Partial<TriageRecord> = {}): TriageRecord {
  return {
    request: sampleSupportRequest,
    result: sampleTriageResult,
    degradedReason: null,
    processedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function stubTriage(result: TriageResult = sampleTriageResult): TriageProvider {
  return { classify: vi.fn(() => Promise.resolve(result)) };
}

export function failingTriage(error: Error): TriageProvider {
  return { classify: vi.fn(() => Promise.reject(error)) };
}

export interface RecordingSink extends NotificationSink {
  sent: TriageRecord[];
}

export function recordingSink(name = "recorder"): RecordingSink {
  const sent: TriageRecord[] = [];
  return {
    name,
    sent,
    notify: (record) => {
      sent.push(record);
      return Promise.resolve();
    },
  };
}

export function failingSink(error: Error, name = "broken"): NotificationSink {
  return { name, notify: vi.fn(() => Promise.reject(error)) };
}

export interface RecordingSlack extends SlackNotifier {
  sent: SlackMessage[];
}

export function recordingSlack(): RecordingSlack {
  const sent: SlackMessage[] = [];
  return {
    sent,
    notify: (message) => {
      sent.push(message);
      return Promise.resolve();
    },
  };
}

export function failingSlack(error: Error): SlackNotifier {
  return { notify: vi.fn(() => Promise.reject(error)) };
}

export interface CapturedLog {
  level: string;
  msg: string;
  fields: LogFields;
}

export function capturingLogger(): { logger: Logger; records: CapturedLog[] } {
  const records: CapturedLog[] = [];
  const logger = createLogger({
    level: "debug",
    write: (level, record) => {
      const { msg, ...fields } = record as { msg: string } & LogFields;
      records.push({ level, msg, fields });
    },
  });
  return { logger, records };
}

export interface TestDeps extends AppDeps {
  sinkRecorder: RecordingSink;
  recordStore: TriageRecordStore;
  records: CapturedLog[];
}

/**
 * Builds a fully-wired app dependency set with no network anywhere.
 * `defer` awaits, so a request is fully processed by the time it returns.
 */
export function testDeps(overrides: Partial<AppDeps> = {}): TestDeps {
  const recordStore = createMemoryRecordStore();
  const sinkRecorder = recordingSink();
  const { logger, records } = capturingLogger();

  return {
    clientSecret: TEST_CLIENT_SECRET,
    eventStore: createMemoryEventStore(),
    triage: stubTriage(),
    sink: createFanOutSink([createDashboardSink(recordStore), sinkRecorder], logger),
    dashboard: { store: recordStore },
    defer: awaitingDefer,
    logger,
    ...overrides,
    sinkRecorder,
    recordStore,
    records,
  };
}
