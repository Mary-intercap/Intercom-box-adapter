/**
 * Structured JSON logger.
 *
 * Privacy posture: this service handles customer support messages, so the
 * default level (`info`) deliberately carries only identifiers and outcomes -
 * event id, conversation id, topic, category, priority, status, error type.
 * Message bodies and customer contact details are only ever emitted at
 * `debug`, which is opt-in via LOG_LEVEL.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Returns a logger that merges `bindings` into every subsequent record. */
  child(bindings: LogFields): Logger;
  readonly level: LogLevel;
}

/**
 * Field names whose values are replaced with `[redacted]` before writing.
 * Belt-and-braces: nothing in this codebase intentionally logs a secret, but a
 * future caller spreading a config object into a log record should not be able
 * to leak one.
 */
const REDACTED_KEY_PATTERN =
  /(secret|token|password|api[-_]?key|authorization|signature|webhook[-_]?url)/i;

const MAX_STRING_FIELD = 2000;

function redact(value: unknown, key: string, depth = 0): unknown {
  if (REDACTED_KEY_PATTERN.test(key)) return "[redacted]";
  if (depth > 4) return "[truncated]";

  if (typeof value === "string") {
    return value.length > MAX_STRING_FIELD
      ? `${value.slice(0, MAX_STRING_FIELD)}...[truncated]`
      : value;
  }
  if (value instanceof Error) {
    // Never serialise `stack` at info level and never serialise `cause` blindly -
    // upstream SDK errors can carry request bodies.
    return { name: value.name, message: value.message };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((entry) => redact(entry, key, depth + 1));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redact(v, k, depth + 1);
    }
    return out;
  }
  return value;
}

function sanitize(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = redact(value, key);
  }
  return out;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Injection seam for tests. Defaults to stdout/stderr via console. */
  write?: (level: LogLevel, record: Record<string, unknown>) => void;
  /** Injection seam for tests. */
  now?: () => Date;
}

function defaultWrite(level: LogLevel, record: Record<string, unknown>): void {
  const line = JSON.stringify(record);
  if (level === "error" || level === "warn") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const write = options.write ?? defaultWrite;
  const now = options.now ?? (() => new Date());

  function build(bindings: LogFields): Logger {
    const log = (recordLevel: LogLevel, message: string, fields?: LogFields): void => {
      if (LEVEL_ORDER[recordLevel] < LEVEL_ORDER[level]) return;
      write(recordLevel, {
        time: now().toISOString(),
        level: recordLevel,
        msg: message,
        ...sanitize({ ...bindings, ...(fields ?? {}) }),
      });
    };

    return {
      level,
      debug: (message, fields) => log("debug", message, fields),
      info: (message, fields) => log("info", message, fields),
      warn: (message, fields) => log("warn", message, fields),
      error: (message, fields) => log("error", message, fields),
      child: (extra) => build({ ...bindings, ...extra }),
    };
  }

  return build({});
}

/** A logger that discards everything. Useful as a default in tests. */
export const nullLogger: Logger = createLogger({ level: "error", write: () => {} });

/** Narrows an unknown thrown value to something safe to put in a log record. */
export function errorInfo(error: unknown): { errorName: string; errorMessage: string } {
  if (error instanceof Error) {
    return { errorName: error.name, errorMessage: error.message };
  }
  return { errorName: "UnknownError", errorMessage: String(error) };
}
