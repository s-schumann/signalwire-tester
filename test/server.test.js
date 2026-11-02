import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { readConfig } from "../src/config.js";
import { createApp } from "../src/server.js";
import { EventStore } from "../src/store.js";

test("Placetel webhook rejects invalid HMAC", async () => {
  const { request, store } = createTestRequestWithStore({
    PLACETEL_SHARED_SECRET: "secret",
  });

  const response = await request("/webhooks/placetel", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "event=IncomingCall&call_id=abc",
  });

  assert.equal(response.status, 401);
  assert.equal(store.listEvents().length, 0);
  assert.equal(store.listCalls().length, 0);

  const malformed = await request("/webhooks/placetel", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{not-json",
  });
  assert.equal(malformed.status, 401);
  assert.equal(store.listEvents().length, 0);
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
  const request = createTestRequest({ API_KEY: "secret-key" }, { autoAuth: false });

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

test("API key works via X-API-Key header but not via query parameter", async () => {
  const request = createTestRequest({ API_KEY: "secret-key" }, { autoAuth: false });

  const headerResponse = await request("/", {
    headers: { "X-API-Key": "secret-key" },
  });
  const queryResponse = await request("/tests?api_key=secret-key");

  assert.equal(headerResponse.status, 200);
  assert.equal(queryResponse.status, 401);
});

test("API index exposes secret configuration only as booleans", async () => {
  const env = {
    API_KEY: "private-api-key-value", SIGNALWIRE_TOKEN: "private-token-value",
    SIGNALWIRE_SIGNING_KEY: "private-signing-value", PLACETEL_SHARED_SECRET: "private-placetel-value",
  };
  const response = await createTestRequest(env)("/");
  assert.equal(response.status, 200);
  const text = await response.text();
  for (const secret of Object.values(env)) assert.equal(text.includes(secret), false);
  const body = JSON.parse(text);
  assert.equal(body.configured.apiKey, true);
  assert.equal(body.configured.signalWireToken, true);
  assert.equal(body.configured.signalWireSigningKey, true);
  assert.equal(body.configured.placetelSharedSecret, true);
});

test("Round-trip test fails until all required callback types are present", async () => {
  const request = createTestRequest({
    PUBLIC_BASE_URL: "https://tester.example",
    SIGNALWIRE_BASE_URL: "https://signalwire.example/api/laml/2010-04-01",
    SIGNALWIRE_PROJECT_ID: "project-id",
    SIGNALWIRE_TOKEN: "token",
    SIGNALWIRE_FROM: "+4915228817386",
    DEFAULT_TO: "+493023125000",
    API_KEY: "test-key",
    SIGNALWIRE_VERIFY_WEBHOOKS: "false",
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
        "call_id=PL123&direction=in&event=IncomingCall&from=015228817386&to=03023125000",
    });
    await request("/webhooks/placetel", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:
        "call_id=PL123&direction=in&event=HungUp&from=015228817386&to=03023125000",
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
    SIGNALWIRE_BASE_URL: "https://signalwire.example/api/laml/2010-04-01",
    SIGNALWIRE_PROJECT_ID: "project-id",
    SIGNALWIRE_TOKEN: "token",
    SIGNALWIRE_FROM: "+496990009000",
    DEFAULT_TO: "+493023125000",
    API_KEY: "test-key",
    SIGNALWIRE_VERIFY_WEBHOOKS: "false",
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
        "call_id=PL456&direction=in&event=IncomingCall&from=06990009000&to=03023125000",
    });
    await request("/webhooks/placetel", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:
        "call_id=PL456&direction=in&event=HungUp&from=06990009000&to=03023125000",
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
    SIGNALWIRE_BASE_URL: "https://signalwire.example/api/laml/2010-04-01",
    SIGNALWIRE_PROJECT_ID: "project-id",
    SIGNALWIRE_TOKEN: "token",
    SIGNALWIRE_FROM: "+496990009000",
    DEFAULT_TO: "+493023125000",
    API_KEY: "test-key",
    SIGNALWIRE_VERIFY_WEBHOOKS: "false",
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
        "call_id=PL789&direction=in&event=IncomingCall&from=06990009000&to=03023125000",
    });
    await request("/webhooks/placetel", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:
        "call_id=PL789&direction=in&event=HungUp&from=06990009000&to=03023125000",
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
    SIGNALWIRE_BASE_URL: "https://signalwire.example/api/laml/2010-04-01",
    SIGNALWIRE_PROJECT_ID: "project-id",
    SIGNALWIRE_TOKEN: "token",
    SIGNALWIRE_FROM: "+496990009000",
    DEFAULT_TO: "+493023125000",
    API_KEY: "test-key",
    SIGNALWIRE_VERIFY_WEBHOOKS: "false",
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

test("Round-trip test can skip waiting for Placetel webhooks", async () => {
  const request = createTestRequest({
    PUBLIC_BASE_URL: "https://tester.example",
    SIGNALWIRE_BASE_URL: "https://signalwire.example/api/laml/2010-04-01",
    SIGNALWIRE_PROJECT_ID: "project-id",
    SIGNALWIRE_TOKEN: "token",
    SIGNALWIRE_FROM: "+496990009000",
    DEFAULT_TO: "+493023125000",
    API_KEY: "test-key",
    SIGNALWIRE_VERIFY_WEBHOOKS: "false",
    WAIT_FOR_PLACETEL_WEBHOOK: "false",
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ sid: "SW-NO-PLACETEL", status: "queued" }), {
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
      body: "CallSid=SW-NO-PLACETEL&CallStatus=completed",
    });

    const testResponse = await request(`/tests/${createdBody.test.id}`);
    const testBody = await testResponse.json();

    assert.equal(testBody.test.status, "ok");
    assert.equal(testBody.test.ok, true);
    assert.deepEqual(testBody.test.missing, []);
    assert.equal("placetelIncomingCall" in testBody.test.expected, false);
    assert.equal("placetelHungUp" in testBody.test.expected, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Synchronous round-trip check can skip waiting for Placetel webhooks by query", async () => {
  const request = createTestRequest({
    PUBLIC_BASE_URL: "https://tester.example",
    SIGNALWIRE_BASE_URL: "https://signalwire.example/api/laml/2010-04-01",
    SIGNALWIRE_PROJECT_ID: "project-id",
    SIGNALWIRE_TOKEN: "token",
    SIGNALWIRE_FROM: "+496990009000",
    DEFAULT_TO: "+493023125000",
    API_KEY: "test-key",
    SIGNALWIRE_VERIFY_WEBHOOKS: "false",
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ sid: "SW-QUERY-NO-PLACETEL", status: "queued" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });

  try {
    const pendingResponse = request(
      "/checks/round-trip?waitTimeoutMs=1000&waitForPlacetelWebhook=false",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const tests = await request("/tests");
    const testId = (await tests.json()).tests[0].id;
    await request(`/webhooks/signalwire/status?test_id=${testId}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "CallSid=SW-QUERY-NO-PLACETEL&CallStatus=completed",
    });

    const response = await pendingResponse;
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.missing, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Round-trip test appends test ID to configured SignalWire callback URLs", async () => {
  const request = createTestRequest({
    PUBLIC_BASE_URL: "https://tester.example",
    SIGNALWIRE_BASE_URL: "https://signalwire.example/api/laml/2010-04-01",
    SIGNALWIRE_PROJECT_ID: "project-id",
    SIGNALWIRE_TOKEN: "token",
    SIGNALWIRE_FROM: "+496990009000",
    DEFAULT_TO: "+493023125000",
    API_KEY: "test-key",
    SIGNALWIRE_VERIFY_WEBHOOKS: "false",
    SIGNALWIRE_VOICE_WEBHOOK_URL: "https://proxy.example/voice?source=monitor",
    SIGNALWIRE_STATUS_WEBHOOK_URL: "https://proxy.example/status?source=monitor",
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ sid: "SW-CALLBACKS", status: "queued" }), {
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

    assert.equal(
      createdBody.test.signalWireRequest.url,
      `https://proxy.example/voice?source=monitor&test_id=${createdBody.test.id}`,
    );
    assert.equal(
      createdBody.test.signalWireRequest.statusCallback,
      `https://proxy.example/status?source=monitor&test_id=${createdBody.test.id}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("SignalWire status webhook requires a valid signature in direct mode", async () => {
  const request = createTestRequest({
    PUBLIC_BASE_URL: "https://tester.example",
    SIGNALWIRE_BASE_URL: "https://signalwire.example/api/laml/2010-04-01",
    SIGNALWIRE_PROJECT_ID: "project-id",
    SIGNALWIRE_TOKEN: "api-token",
    SIGNALWIRE_SIGNING_KEY: "signing-key",
    SIGNALWIRE_FROM: "+496990009000",
    DEFAULT_TO: "+493023125000",
  });

  const path = "/webhooks/signalwire/status?test_id=abc";
  const body = "CallSid=SW1&CallStatus=completed";
  const params = Object.fromEntries(new URLSearchParams(body));

  const unsigned = await request(path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  assert.equal(unsigned.status, 403);

  const signature = signalWireSignature("signing-key", `https://tester.example${path}`, params);
  const signed = await request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-SignalWire-Signature": signature,
    },
    body,
  });
  assert.equal(signed.status, 200);
});

test("SignalWire status webhook accepts Twilio-compatible signature header", async () => {
  const request = createTestRequest({
    PUBLIC_BASE_URL: "https://tester.example",
    SIGNALWIRE_BASE_URL: "https://signalwire.example/api/laml/2010-04-01",
    SIGNALWIRE_PROJECT_ID: "project-id",
    SIGNALWIRE_TOKEN: "api-token",
    SIGNALWIRE_SIGNING_KEY: "signing-key",
    SIGNALWIRE_FROM: "+496990009000",
    DEFAULT_TO: "+493023125000",
  });

  const path = "/webhooks/signalwire/status?test_id=abc";
  const body = "CallSid=SW1&CallStatus=completed";
  const params = Object.fromEntries(new URLSearchParams(body));
  const signature = signalWireSignature("signing-key", `https://tester.example${path}`, params);

  const response = await request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Twilio-Signature": signature,
    },
    body,
  });

  assert.equal(response.status, 200);
});

test("SignalWire signature check is skipped when a callback URL override is set", async () => {
  const request = createTestRequest({
    PUBLIC_BASE_URL: "https://tester.example",
    SIGNALWIRE_TOKEN: "token",
    SIGNALWIRE_STATUS_WEBHOOK_URL: "https://proxy.example/status",
  });

  const response = await request("/webhooks/signalwire/status?test_id=abc", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "CallSid=SW1&CallStatus=completed",
  });

  assert.equal(response.status, 200);
});

test("Forced SignalWire verification rejects webhooks when configuration is missing", async () => {
  for (const env of [
    { PUBLIC_BASE_URL: "https://tester.example" },
    { SIGNALWIRE_SIGNING_KEY: "signing-key" },
  ]) {
    const { request, store } = createTestRequestWithStore({
      ...env,
      SIGNALWIRE_VERIFY_WEBHOOKS: "on",
    });

    for (const kind of ["status", "voice"]) {
      const response = await request(`/webhooks/signalwire/${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "CallSid=SW1&CallStatus=completed",
      });
      assert.equal(response.status, 403);
    }
    assert.equal(store.listEvents().length, 0);
  }
});

test("Destination outside ALLOWED_TO_NUMBERS is rejected before placing a call", async () => {
  const request = createTestRequest({
    PUBLIC_BASE_URL: "https://tester.example",
    SIGNALWIRE_BASE_URL: "https://signalwire.example/api/laml/2010-04-01",
    SIGNALWIRE_PROJECT_ID: "project-id",
    SIGNALWIRE_TOKEN: "token",
    SIGNALWIRE_FROM: "+496990009000",
    DEFAULT_TO: "+493023125000",
    API_KEY: "test-key",
    ALLOWED_TO_NUMBERS: "+493023125000",
  });

  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return new Response(JSON.stringify({ sid: "SW1" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    for (const to of [
      "+1900555000", "5000", "+1493023125000",
      "sip:+493023125000@attacker.example", "+493023125000#",
    ]) {
      for (const path of ["/calls", "/tests"]) {
        const rejected = await request(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to }),
        });
        assert.equal(rejected.status, 403, `${path} must reject ${to}`);
      }
      const check = await request(`/checks/round-trip?to=${encodeURIComponent(to)}`);
      assert.equal(check.status, 403);
    }
    assert.equal(fetchCalled, false);

    for (const to of ["+493023125000", "00493023125000", "03023125000"]) {
      const allowed = await request("/calls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to }),
      });
      assert.equal(allowed.status, 201);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Request body over the size limit is rejected", async () => {
  const request = createTestRequest({ API_KEY: "test-key" });

  const response = await request("/calls", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "x".repeat(256 * 1024 + 1),
  });

  assert.equal(response.status, 413);
});

test("Call creation is disabled when API_KEY is not configured", async () => {
  const request = createTestRequest({
    PUBLIC_BASE_URL: "https://tester.example",
    SIGNALWIRE_BASE_URL: "https://signalwire.example/api/laml/2010-04-01",
    SIGNALWIRE_PROJECT_ID: "project-id",
    SIGNALWIRE_TOKEN: "token",
    SIGNALWIRE_FROM: "+496990009000",
    DEFAULT_TO: "+493023125000",
  });

  const response = await request("/calls", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });

  assert.equal(response.status, 503);
});

test("Failed call creation leaves a failed test without leaking upstream detail", async () => {
  const { request, store } = createTestRequestWithStore({
    API_KEY: "test-key", PUBLIC_BASE_URL: "https://tester.example",
    SIGNALWIRE_BASE_URL: "https://signalwire.example/api/laml/2010-04-01",
    SIGNALWIRE_PROJECT_ID: "project-id", SIGNALWIRE_TOKEN: "test-token",
    SIGNALWIRE_FROM: "+496990009000", DEFAULT_TO: "+493023125000",
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("private upstream details"); };
  try {
    const response = await request("/tests", { method: "POST", body: "" });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "Internal server error" });
    const [roundTrip] = store.listTests();
    assert.equal(roundTrip.status, "failed");
    assert.equal(roundTrip.ok, false);
    assert.equal(roundTrip.reason, "SignalWire call creation failed.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function signalWireSignature(token, fullUrl, params) {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], fullUrl);
  return crypto.createHmac("sha1", token).update(Buffer.from(data, "utf8")).digest("base64");
}

function createTestRequest(env, opts) {
  return createTestRequestWithStore(env, opts).request;
}

function createTestRequestWithStore(env, { autoAuth = true } = {}) {
  const config = readConfig({ PORT: "0", ...env });
  const store = new EventStore();
  const app = createApp(config, store);

  return {
    store,
    request: async function request(path, options = {}) {
    const headers = normalizeHeaders(options.headers || {});
    if (autoAuth && env.API_KEY && !headers.authorization && !headers["x-api-key"]) {
      headers.authorization = `Bearer ${env.API_KEY}`;
    }
    const req = Readable.from([options.body || ""]);
    req.method = options.method || "GET";
    req.url = path;
    req.headers = headers;

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
