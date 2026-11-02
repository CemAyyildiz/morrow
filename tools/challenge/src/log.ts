export type LogLevel = "debug" | "info" | "warn" | "error";

export type Logger = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/** The watcher's pattern (services/watcher/src/log.ts) plus `full_access`. */
const SENSITIVE = /key|secret|pin|token|seed|password|envelope|mnemonic|private|full_access/i;

/**
 * Replaces values of sensitive-looking fields, at any depth. Fields whose name ends in
 * `public_key` pass through: public keys are published anyway.
 */
export function redact(value: unknown, field = ""): unknown {
  if (field && SENSITIVE.test(field) && !/public_key$/i.test(field)) return "[redacted]";
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  }
  return value;
}

/** JSON-line logger on stderr: `{ts, level, component, ..., msg}`. */
export function createLogger(
  component: string,
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Logger {
  return (level, msg, fields = {}) => {
    write(
      JSON.stringify({
        ts: new Date().toISOString(),
        level,
        component,
        ...(redact(fields) as object),
        msg,
      }),
    );
  };
}
