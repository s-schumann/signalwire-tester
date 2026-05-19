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
    this.tests = new Map();
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

    this.attachEventToTests(event);

    await mkdir(logDir, { recursive: true });
    await appendFile(logFile, `${JSON.stringify(event)}\n`);
    return event;
  }

  createTest(input) {
    const now = new Date();
    const test = {
      id: randomUUID(),
      status: "starting",
      ok: false,
      reason: "SignalWire call has not been created yet.",
      expected: {
        signalWireCallCreated: false,
        signalWireStatus: false,
        signalWireTerminal: false,
        placetelIncomingCall: false,
        placetelHungUp: false,
      },
      request: input,
      events: [],
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      timeoutAt: new Date(now.getTime() + input.timeoutMs).toISOString(),
    };
    this.tests.set(test.id, test);
    return test;
  }

  markTestCallCreated(testId, result) {
    const test = this.tests.get(testId);
    if (!test) return;

    test.signalWireCallSid = result.response.sid || result.response.call_sid;
    test.signalWireResponse = result.response;
    test.signalWireRequest = result.request;
    test.status = "pending";
    test.reason = "Waiting for SignalWire and Placetel webhooks.";
    test.updatedAt = new Date().toISOString();
    this.evaluateTest(test);
  }

  listTests() {
    const now = Date.now();
    return [...this.tests.values()]
      .map((test) => this.evaluateTest(test, now))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  getTest(id) {
    const test = this.tests.get(id);
    return test ? this.evaluateTest(test) : null;
  }

  attachEventToTests(event) {
    const explicitTestId = event.meta?.testId || event.payload?.test_id;
    if (explicitTestId && this.tests.has(explicitTestId)) {
      this.attachEventToTest(this.tests.get(explicitTestId), event);
      return;
    }

    for (const test of this.tests.values()) {
      if (this.eventMatchesTest(test, event)) {
        this.attachEventToTest(test, event);
      }
    }
  }

  attachEventToTest(test, event) {
    if (test.events.some((existing) => existing.id === event.id)) return;

    test.events.push(event);
    test.updatedAt = event.receivedAt;
    this.evaluateTest(test);
  }

  eventMatchesTest(test, event) {
    if (test.status !== "pending" && test.status !== "starting") return false;
    if (new Date(event.receivedAt) < new Date(test.createdAt)) return false;

    const payload = event.payload || {};
    if (
      test.signalWireCallSid &&
      (payload.CallSid === test.signalWireCallSid ||
        payload.call_sid === test.signalWireCallSid ||
        payload.sid === test.signalWireCallSid)
    ) {
      return true;
    }

    if (event.type !== "placetel.webhook") return false;

    const expectedTo = normalizePhone(test.request.to);
    const expectedFrom = normalizePhone(test.request.from);
    const actualTo = normalizePhone(payload.to);
    const actualFrom = normalizePhone(payload.from);

    const toMatches = phoneMatches(expectedTo, actualTo);
    const fromMatches =
      !expectedFrom ||
      !actualFrom ||
      phoneMatches(expectedFrom, actualFrom);

    return Boolean(toMatches && fromMatches);
  }

  evaluateTest(test, now = Date.now()) {
    const expected = {
      signalWireCallCreated: Boolean(test.signalWireCallSid),
      signalWireStatus: false,
      signalWireTerminal: false,
      placetelIncomingCall: false,
      placetelHungUp: false,
    };

    for (const event of test.events) {
      if (event.type === "signalwire.status") {
        expected.signalWireStatus = true;
        const status =
          event.payload.CallStatus ||
          event.payload.CallState ||
          event.payload.call_status ||
          event.payload.call_state;
        if (isSignalWireTerminalStatus(status)) {
          expected.signalWireTerminal = true;
        }
      }

      if (event.type === "placetel.webhook") {
        const placetelEvent = String(event.payload.event || "").toLowerCase();
        if (placetelEvent === "incomingcall") expected.placetelIncomingCall = true;
        if (placetelEvent === "hungup") expected.placetelHungUp = true;
      }
    }

    test.expected = expected;
    const missing = Object.entries(expected)
      .filter(([, present]) => !present)
      .map(([key]) => key);
    test.missing = missing;
    test.ok = missing.length === 0;

    if (test.ok) {
      test.status = "ok";
      test.reason = "All required SignalWire and Placetel callbacks were received.";
    } else if (test.status !== "starting" && now > new Date(test.timeoutAt).getTime()) {
      test.status = "failed";
      test.reason = `Timed out waiting for: ${missing.join(", ")}`;
    } else if (test.status !== "starting") {
      test.status = "pending";
      test.reason = `Waiting for: ${missing.join(", ")}`;
    }

    return test;
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

function normalizePhone(value = "") {
  return String(value).replace(/\D/g, "").replace(/^00/, "");
}

function phoneMatches(left, right) {
  if (!left || !right) return false;

  const leftCandidates = phoneCandidates(left);
  const rightCandidates = phoneCandidates(right);

  return leftCandidates.some((leftCandidate) =>
    rightCandidates.some(
      (rightCandidate) =>
        leftCandidate === rightCandidate ||
        leftCandidate.endsWith(rightCandidate) ||
        rightCandidate.endsWith(leftCandidate),
    ),
  );
}

function phoneCandidates(value) {
  const normalized = normalizePhone(value);
  const candidates = new Set([normalized]);

  if (normalized.startsWith("49")) {
    candidates.add(`0${normalized.slice(2)}`);
  }

  if (normalized.startsWith("0")) {
    candidates.add(`49${normalized.slice(1)}`);
  }

  return [...candidates];
}

function isSignalWireTerminalStatus(status) {
  return ["completed", "busy", "no-answer", "failed", "canceled"].includes(
    String(status || "").toLowerCase(),
  );
}
