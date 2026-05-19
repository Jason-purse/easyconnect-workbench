import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

const EXACT_SENSITIVE_KEYS = new Set([
  "body",
  "cookie",
  "password",
  "set-cookie",
  "token",
  "twfid",
  "xml",
]);

const SENSITIVE_KEY_PARTS = [
  "cookie",
  "password",
  "secret",
  "token",
  "twfid",
];

function isSensitiveKey(key) {
  const normalized = `${key}`.toLowerCase();
  return EXACT_SENSITIVE_KEYS.has(normalized) || SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

function redactValue(value, seen) {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  const next = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      continue;
    }

    const redacted = redactValue(child, seen);
    if (redacted !== undefined) {
      next[key] = redacted;
    }
  }

  seen.delete(value);
  return next;
}

export function redactMaintainerEvent(event) {
  return redactValue(event, new WeakSet());
}

export function createMaintainerLogger(logDir, options = {}) {
  const clock = options.clock ?? (() => new Date().toISOString());
  const filePath = path.join(logDir, "maintainer.jsonl");

  return {
    filePath,
    async write(event, payload = {}) {
      await mkdir(logDir, { recursive: true });
      const record = redactMaintainerEvent({
        timestamp: clock(),
        event,
        ...payload,
      });
      await appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
      return record;
    },
  };
}
