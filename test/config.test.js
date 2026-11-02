import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "../src/config.js";

test("SignalWire request deadline has a bounded default and configuration", () => {
  for (const [value, expected] of [
    [undefined, 15000], ["invalid", 15000], ["0", 1],
    ["-1", 1], ["2500", 2500], ["999999", 60000],
  ]) {
    assert.equal(readConfig({ SIGNALWIRE_REQUEST_TIMEOUT_MS: value }).signalWire.requestTimeoutMs, expected);
  }
});
