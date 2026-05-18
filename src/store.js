import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const logDir = join(root, "data");
const logFile = join(logDir, "events.jsonl");

export class EventStore {
  constructor() {
    this.calls = new Map();
    this.events = [];
  }

  async record(type, payload, meta = {}) {
    const event = {
      id: randomUUID(),
      type,
      payload,
      meta,
      receivedAt: new Date().toISOString(),
    };
    this.events.push(event);
    if (this.events.length > 500) this.events.shift();

    const callId =
      payload?.CallSid ||
      payload?.call_sid ||
      payload?.call_id ||
      payload?.sid ||
      meta?.testId;
    if (callId) {
      const existing = this.calls.get(callId) || { id: callId, events: [] };
      existing.events.push(event);
      existing.updatedAt = event.receivedAt;
      this.calls.set(callId, existing);
    }

    await mkdir(logDir, { recursive: true });
    await appendFile(logFile, `${JSON.stringify(event)}\n`);
    return event;
  }

  upsertCall(id, patch) {
    const existing = this.calls.get(id) || { id, events: [] };
    Object.assign(existing, patch, { updatedAt: new Date().toISOString() });
    this.calls.set(id, existing);
    return existing;
  }

  listEvents(limit = 100) {
    return this.events.slice(-limit).reverse();
  }

  listCalls() {
    return [...this.calls.values()].sort((a, b) =>
      String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")),
    );
  }
}
