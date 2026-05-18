import assert from "node:assert/strict";
import test from "node:test";
import { placetelControlXml, signalWireVoiceXml } from "../src/xml.js";

test("SignalWire voice XML escapes spoken text", () => {
  const xml = signalWireVoiceXml('A < B & "quoted"');

  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(xml, /A &lt; B &amp; &quot;quoted&quot;/);
  assert.match(xml, /<Hangup\/>/);
});

test("Placetel forward XML includes configured targets", () => {
  const xml = placetelControlXml({
    action: "forward",
    forwardTargets: ["7777abcdefg@fpbx.de", "03023125001"],
    forwardRingtime: 45,
  });

  assert.match(xml, /<Forward>/);
  assert.match(xml, /ringtime="45"/);
  assert.match(xml, /<Number>7777abcdefg@fpbx.de<\/Number>/);
  assert.match(xml, /<Number>03023125001<\/Number>/);
});

test("Placetel missing forward target falls back to hangup", () => {
  const xml = placetelControlXml({ action: "forward", forwardTargets: [] });

  assert.match(xml, /<Hangup \/>/);
});
