export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  vault_id?: string;
  op_id?: string;
  seq?: string;
  [field: string]: unknown;
}

export type Logger = (level: LogLevel, msg: string, fields?: LogFields) => void;

const SENSITIVE = /key|secret|pin|token|seed|password|envelope|mnemonic|private/i;

/** Replaces values of sensitive-looking fields, at any depth. */
export function redact(value: unknown, field = ""): unknown {
  if (field && SENSITIVE.test(field)) return "[redacted]";
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  }
  return value;
}

/** JSON-line logger: `{ts, level, component, vault_id?, op_id?, seq?, msg, ...}`. */
export function createLogger(
  component: string,
  write: (line: string) => void = (l) => process.stdout.write(`${l}\n`),
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
