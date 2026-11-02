import assert from "node:assert/strict";
import test from "node:test";
import { EventStore, phoneMatches } from "../src/store.js";

test("Phone matching requires the full number while accepting German national format", () => {
  assert.equal(phoneMatches("+493023125000", "03023125000"), true);
  assert.equal(phoneMatches("+493023125000", "00493023125000"), true);
  for (const number of ["5000", "+1493023125000", "", "abc"]) {
    assert.equal(phoneMatches("+493023125000", number), false);
  }
  assert.equal(phoneMatches("abc", "def"), false);
});

test("Placetel callbacks with partial numbers do not satisfy a round-trip test", () => {
  const store = new EventStore();
  const roundTrip = store.createTest({
    to: "+493023125000",
    from: "+496990009000",
    timeoutMs: 10000,
    waitForPlacetelWebhook: true,
  });

  for (const to of ["5000", "+1493023125000"]) {
    assert.equal(store.eventMatchesTest(roundTrip, {
      type: "placetel.webhook",
      receivedAt: new Date().toISOString(),
      payload: { to, from: "06990009000", event: "IncomingCall" },
    }), false);
  }
});

function pendingTest(store, sid = "SW1", waitForPlacetelWebhook = false) {
  const roundTrip = store.createTest({
    to: "+493023125000", from: "+496990009000", timeoutMs: 10000,
    waitForPlacetelWebhook,
  });
  store.markTestCallCreated(roundTrip.id, { response: { sid }, request: {} });
  return roundTrip;
}

test("Placetel payload IDs cannot bypass number correlation", () => {
  const store = new EventStore();
  const roundTrip = pendingTest(store, "SW1", true);
  for (const extra of [{ test_id: roundTrip.id }, { CallSid: "SW1" }]) {
    store.attachEventToTests({
      id: JSON.stringify(extra), type: "placetel.webhook",
      receivedAt: new Date().toISOString(),
      payload: { ...extra, event: "IncomingCall", to: "+1900555000", from: "+1900555001" },
    });
  }
  assert.equal(roundTrip.events.length, 0);
  assert.equal(roundTrip.expected.placetelIncomingCall, false);
});

test("An explicit SignalWire test ID must agree with the call SID and never fall back", () => {
  const store = new EventStore();
  const first = pendingTest(store, "SW1");
  const second = pendingTest(store, "SW2");
  for (const testId of [first.id, "unknown-test"]) {
    store.attachEventToTests({
      id: testId, type: "signalwire.status", meta: { testId },
      receivedAt: new Date().toISOString(),
      payload: { CallSid: "SW2", CallStatus: "completed" },
    });
  }
  assert.equal(first.events.length, 0);
  assert.equal(second.events.length, 0);
});

test("Late callbacks cannot turn a timed-out test into a pass", () => {
  const store = new EventStore();
  const roundTrip = pendingTest(store);
  roundTrip.timeoutAt = new Date(Date.now() - 1).toISOString();
  store.attachEventToTests({
    id: "late", type: "signalwire.status", meta: { testId: roundTrip.id },
    receivedAt: new Date().toISOString(),
    payload: { CallSid: "SW1", CallStatus: "completed" },
  });
  assert.equal(store.getTest(roundTrip.id).status, "failed");
  assert.equal(roundTrip.ok, false);
  assert.equal(roundTrip.events.length, 0);
});
