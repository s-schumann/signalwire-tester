import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { readConfig } from "../src/config.js";
import { createApp } from "../src/server.js";
import { EventStore } from "../src/store.js";

test("Placetel webhook rejects invalid HMAC", async () => {
  const request = createTestRequest({
    PLACETEL_SHARED_SECRET: "secret",
  });

  const response = await request("/webhooks/placetel", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "event=IncomingCall&call_id=abc",
  });

  assert.equal(response.status, 401);
});

test("Placetel webhook accepts valid HMAC and returns XML", async () => {
  const body = "event=IncomingCall&call_id=abc";
  const signature = crypto.createHmac("sha256", "secret").update(body).digest("hex");
  const request = createTestRequest({
    PLACETEL_SHARED_SECRET: "secret",
    PLACETEL_ACTION: "busy",
  });

  const response = await request("/webhooks/placetel", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-PLACETEL-SIGNATURE": signature,
    },
    body,
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/xml; charset=utf-8");
  assert.match(await response.text(), /<Reject reason="busy" \/>/);
});

test("API key protects non-webhook endpoints when configured", async () => {
  const request = createTestRequest({ API_KEY: "secret-key" });

  const unauthenticated = await request("/tests");
  const webhook = await request("/webhooks/signalwire/status", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "CallSid=abc&CallStatus=completed",
  });
  const authenticated = await request("/tests", {
    headers: { Authorization: "Bearer secret-key" },
  });

  assert.equal(unauthenticated.status, 401);
  assert.equal(webhook.status, 200);
  assert.equal(authenticated.status, 200);
});

test("API key can be supplied through X-API-Key or query parameter", async () => {
  const request = createTestRequest({ API_KEY: "secret-key" });

  const headerResponse = await request("/", {
    headers: { "X-API-Key": "secret-key" },
  });
  const queryResponse = await request("/tests?api_key=secret-key");

  assert.equal(headerResponse.status, 200);
  assert.equal(queryResponse.status, 200);
});

test("Round-trip test fails until all required callback types are present", async () => {
  const request = createTestRequest({
    PUBLIC_BASE_URL: "https://tester.example",
    SIGNALWIRE_BASE_URL: "https://signalwire.example",
    SIGNALWIRE_PROJECT_ID: "project-id",
    SIGNALWIRE_TOKEN: "token",
    SIGNALWIRE_FROM: "+4915228817386",
    DEFAULT_TO: "+493023125000",
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ sid: "SW123", status: "queued" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });

  try {
    const created = await request("/tests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const createdBody = await created.json();

    assert.equal(created.status, 201);
    assert.equal(createdBody.test.status, "pending");
    assert.deepEqual(createdBody.test.missing, [
      "signalWireStatus",
      "signalWireTerminal",
      "placetelIncomingCall",
      "placetelHungUp",
    ]);

    await request(`/webhooks/signalwire/status?test_id=${createdBody.test.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "CallSid=SW123&CallStatus=completed",
    });
    await request("/webhooks/placetel", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:
        "call_id=PL123&direction=in&event=IncomingCall&from=015226453669&to=030515659470",
    });
    await request("/webhooks/placetel", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:
        "call_id=PL123&direction=in&event=HungUp&from=015226453669&to=030515659470",
    });

    const listed = await request("/tests");
    const listedBody = await listed.json();

    assert.equal(listedBody.tests[0].id, createdBody.test.id);
    assert.equal(listedBody.tests[0].status, "ok");
    assert.equal(listedBody.tests[0].ok, true);
    assert.deepEqual(listedBody.tests[0].missing, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Round-trip test treats SignalWire busy as terminal for hangup flows", async () => {
  const request = createTestRequest({
    PUBLIC_BASE_URL: "https://tester.example",
    SIGNALWIRE_BASE_URL: "https://signalwire.example",
    SIGNALWIRE_PROJECT_ID: "project-id",
    SIGNALWIRE_TOKEN: "token",
    SIGNALWIRE_FROM: "+496990009000",
    DEFAULT_TO: "+493023125000",
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ sid: "SW456", status: "queued" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });

  try {
    const created = await request("/tests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const createdBody = await created.json();

    await request(`/webhooks/signalwire/status?test_id=${createdBody.test.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "CallSid=SW456&CallStatus=busy&SipResultCode=603",
    });
    await request("/webhooks/placetel", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:
        "call_id=PL456&direction=in&event=IncomingCall&from=069200602148&to=030515659470",
    });
    await request("/webhooks/placetel", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:
        "call_id=PL456&direction=in&event=HungUp&from=069200602148&to=030515659470",
    });

    const testResponse = await request(`/tests/${createdBody.test.id}`);
    const testBody = await testResponse.json();

    assert.equal(testBody.test.status, "ok");
    assert.deepEqual(testBody.test.missing, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Synchronous round-trip check returns 200 when callbacks complete before timeout", async () => {
  const { request, store } = createTestRequestWithStore({
    PUBLIC_BASE_URL: "https://tester.example",
    SIGNALWIRE_BASE_URL: "https://signalwire.example",
    SIGNALWIRE_PROJECT_ID: "project-id",
    SIGNALWIRE_TOKEN: "token",
    SIGNALWIRE_FROM: "+496990009000",
    DEFAULT_TO: "+493023125000",
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ sid: "SW789", status: "queued" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });

  try {
    const pendingResponse = request("/checks/round-trip?waitTimeoutMs=1000");
    await waitUntil(() => store.listTests().length === 1);
    const test = store.listTests()[0];

    await request(`/webhooks/signalwire/status?test_id=${test.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "CallSid=SW789&CallStatus=completed",
    });
    await request("/webhooks/placetel", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:
        "call_id=PL789&direction=in&event=IncomingCall&from=069200602148&to=030515659470",
    });
    await request("/webhooks/placetel", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:
        "call_id=PL789&direction=in&event=HungUp&from=069200602148&to=030515659470",
    });

    const response = await pendingResponse;
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.test.id, test.id);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Synchronous round-trip check returns 503 when callbacks do not complete", async () => {
  const request = createTestRequest({
    PUBLIC_BASE_URL: "https://tester.example",
    SIGNALWIRE_BASE_URL: "https://signalwire.example",
    SIGNALWIRE_PROJECT_ID: "project-id",
    SIGNALWIRE_TOKEN: "token",
    SIGNALWIRE_FROM: "+496990009000",
    DEFAULT_TO: "+493023125000",
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ sid: "SW999", status: "queued" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });

  try {
    const response = await request("/checks/round-trip?waitTimeoutMs=10");
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.equal(body.ok, false);
    assert.match(body.reason, /Waiting for|Timed out/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function createTestRequest(env) {
  return createTestRequestWithStore(env).request;
}

function createTestRequestWithStore(env) {
  const config = readConfig({ PORT: "0", ...env });
  const store = new EventStore();
  const app = createApp(config, store);

  return {
    store,
    request: async function request(path, options = {}) {
    const req = Readable.from(options.body || "");
    req.method = options.method || "GET";
    req.url = path;
    req.headers = normalizeHeaders(options.headers || {});

    const chunks = [];
    const res = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    res.writeHead = (status, headers) => {
      res.statusCode = status;
      res.headers = headers;
      return res;
    };

    await app(req, res);
    return new Response(Buffer.concat(chunks), {
      status: res.statusCode,
      headers: res.headers,
    });
    },
  };
}

function normalizeHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
}

async function waitUntil(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for predicate");
}
