type LogLevel = "debug" | "info" | "warn" | "error";

type LogFields = Record<string, unknown>;

const secretKey = /(api[_-]?key|authorization|cookie|secret|token|password|credential|endpoint)/i;
const debugFlag = (): boolean => ["1", "true", "yes", "on"].includes(String(Bun.env.JIGEUMTA_DEBUG || Bun.env.DEBUG_DIAGNOSTICS || "").toLowerCase());

function redact(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[depth-limit]";
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => redact(entry, depth + 1));
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) output[key] = secretKey.test(key) ? "[redacted]" : redact(child, depth + 1);
    return output;
  }
  if (typeof value === "string" && value.length > 2000) return `${value.slice(0, 2000)}…`;
  return value;
}

export function requestId(request?: Request): string {
  const supplied = request?.headers.get("x-request-id")?.trim();
  return supplied && /^[A-Za-z0-9._:-]{8,128}$/.test(supplied) ? supplied : crypto.randomUUID();
}

export function logEvent(level: LogLevel, eventType: string, fields: LogFields = {}): void {
  if (level === "debug" && !debugFlag()) return;
  const record = { ts: new Date().toISOString(), level, event_type: eventType, ...redact(fields) as LogFields };
  const line = `JIGEUMTA_LOG ${JSON.stringify(record)}`;
  if (level === "error") console.error(line); else if (level === "warn") console.warn(line); else console.log(line);
}

export function debugEnabled(): boolean { return debugFlag(); }
export function publicError(error: unknown): { error_id: string; detail?: string } {
  const error_id = crypto.randomUUID();
  const detail = debugFlag() && error instanceof Error ? `${error.name}: ${error.message}` : undefined;
  return { error_id, detail };
}
