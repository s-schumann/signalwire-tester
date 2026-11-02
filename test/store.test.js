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
