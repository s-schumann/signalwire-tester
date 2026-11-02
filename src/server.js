import crypto from "node:crypto";
import http from "node:http";
import { URL } from "node:url";
import { loadDotEnv, readConfig, requireSignalWireConfig } from "./config.js";
import { logInteraction } from "./logger.js";
import { isValidSignalWireSignature } from "./signature.js";
import { createSignalWireCall } from "./signalwire.js";
import { EventStore, normalizePhone, phoneMatches } from "./store.js";
import { placetelControlXml, signalWireVoiceXml } from "./xml.js";

loadDotEnv();
const config = readConfig();
const store = new EventStore();

const MAX_BODY_BYTES = 256 * 1024;
const MAX_TIMEOUT_MS = 600000;

export function createApp(config, store) {
  return async function handle(req, res) {
    try {
      const url = new URL(req.url, "http://localhost");

      if (requiresApiKey(config, req, url) && !isApiKeyAuthorized(config, req)) {
        return send(res, 401, { error: "Unauthorized" }, {
          "WWW-Authenticate": 'Bearer realm="signalwire-placetel-tester"',
        });
      }

      if (req.method === "GET" && url.pathname === "/") {
        return send(res, 200, serviceInfo(config));
      }

      if (req.method === "GET" && url.pathname === "/health") {
        return send(res, 200, { ok: true, time: new Date().toISOString() });
      }

      if (req.method === "GET" && url.pathname === "/checks/round-trip") {
        requireApiKeyConfigured(config);
        const body = Object.fromEntries(url.searchParams.entries());
        logInteraction("Starting synchronous round-trip check", {
          to: body.to || config.signalWire.defaultTo,
          from: body.from || config.signalWire.from,
          waitTimeoutMs: body.waitTimeoutMs || body.timeoutMs || config.signalWire.testTimeoutMs,
        });
        const result = await startRoundTripTest({ body, config, store });
        const waitTimeoutMs = clampTimeout(
          body.waitTimeoutMs || body.timeoutMs,
          config.signalWire.testTimeoutMs,
        );
        const test = await waitForTest(store, result.test.id, waitTimeoutMs);
        logInteraction("Synchronous round-trip check finished", {
          testId: test.id,
          status: test.status,
          ok: test.ok,
          missing: test.missing,
        });
        return send(res, test.ok ? 200 : 503, {
          ok: test.ok,
          status: test.status,
          reason: test.reason,
          missing: test.missing,
          test,
        });
      }

      if (req.method === "GET" && url.pathname === "/events") {
        const limit = Number.parseInt(url.searchParams.get("limit") || "100", 10);
        return send(res, 200, { events: store.listEvents(limit) });
      }

      if (req.method === "GET" && url.pathname === "/calls") {
        return send(res, 200, { calls: store.listCalls() });
      }

      if (req.method === "GET" && url.pathname === "/tests") {
        return send(res, 200, { tests: store.listTests() });
      }

      if (req.method === "GET" && url.pathname.startsWith("/tests/")) {
        const testId = url.pathname.slice("/tests/".length);
        const test = store.getTest(testId);
        if (!test) return send(res, 404, { error: "Test not found" });
        return send(res, 200, { test });
      }

      if (req.method === "POST" && url.pathname === "/tests") {
        requireApiKeyConfigured(config);
        const input = await readRequestBody(req);
        const body = parseBody(input);
        logInteraction("Starting asynchronous round-trip test", {
          to: body.to || config.signalWire.defaultTo,
          from: body.from || config.signalWire.from,
        });
        const result = await startRoundTripTest({ body, config, store });
        return send(res, 201, result);
      }

      if (req.method === "POST" && url.pathname === "/calls") {
        requireApiKeyConfigured(config);
        const input = await readRequestBody(req);
        const body = parseBody(input);
        const callInput = definedOnly({ to: body.to, from: body.from });
        logInteraction("Creating raw SignalWire call", {
          to: callInput.to || config.signalWire.defaultTo,
          from: callInput.from || config.signalWire.from,
        });
        const missing = requireSignalWireConfig(config, callInput);
        if (missing.length) {
          return send(res, 400, {
            error: "Missing SignalWire configuration",
            missing,
          });
        }

        assertAllowedDestination(config, callInput.to || config.signalWire.defaultTo);
        const result = await createSignalWireCall(config, callInput);
        const callSid = result.response.sid || result.response.call_sid;
        if (callSid) {
          store.upsertCall(callSid, {
            provider: "signalwire",
            request: result.request,
            response: result.response,
            createdAt: new Date().toISOString(),
          });
        }
        await store.record("signalwire.call.created", result.response, {
          request: result.request,
        });
        logInteraction("Raw SignalWire call created", {
          callSid: callSid || result.response.sid || result.response.call_sid,
          to: result.request.to,
          from: result.request.from,
          voiceWebhookUrl: result.request.url,
          statusWebhookUrl: result.request.statusCallback,
        });
        return send(res, 201, result);
      }

      if (req.method === "POST" && url.pathname === "/webhooks/signalwire/status") {
        const input = await readRequestBody(req);
        const payload = parseBody(input);
        if (!signalWireSignatureOk(config, "status", req, payload)) {
          logInteraction("Rejected SignalWire status webhook with invalid signature");
          return send(res, 403, { error: "Invalid SignalWire signature" });
        }
        logInteraction("Received SignalWire status webhook", {
          testId: url.searchParams.get("test_id") || undefined,
          callSid: payload.CallSid || payload.call_sid,
          status: payload.CallStatus || payload.call_status,
        });
        const event = await store.record("signalwire.status", payload, {
          headers: selectedHeaders(req.headers),
          testId: url.searchParams.get("test_id") || undefined,
        });
        return send(res, 200, { ok: true, eventId: event.id });
      }

      if (req.method === "POST" && url.pathname === "/webhooks/signalwire/voice") {
        const input = await readRequestBody(req);
        const payload = parseBody(input);
        if (!signalWireSignatureOk(config, "voice", req, payload)) {
          logInteraction("Rejected SignalWire voice webhook with invalid signature");
          return send(res, 403, { error: "Invalid SignalWire signature" });
        }
        logInteraction("Received SignalWire voice webhook", {
          testId: url.searchParams.get("test_id") || undefined,
          callSid: payload.CallSid || payload.call_sid,
          status: payload.CallStatus || payload.call_status,
        });
        await store.record("signalwire.voice", payload, {
          headers: selectedHeaders(req.headers),
          testId: url.searchParams.get("test_id") || undefined,
        });
        return sendXml(res, 200, signalWireVoiceXml(config.signalWire.sayMessage));
      }

      if (req.method === "POST" && url.pathname === "/webhooks/placetel") {
        const input = await readRequestBody(req);
        const signature = req.headers["x-placetel-signature"] || "";
        if (!isValidPlacetelSignature(config.placetel.sharedSecret, input.raw, signature)) {
          logInteraction("Rejected Placetel webhook with invalid signature");
          await store.record("placetel.signature.invalid", parseBody(input), {
            headers: selectedHeaders(req.headers),
          });
          return send(res, 401, { error: "Invalid Placetel signature" });
        }

        const payload = parseBody(input);
        logInteraction("Received Placetel webhook", {
          callId: payload.call_id,
          event: payload.event,
          from: payload.from,
          to: payload.to,
        });
        await store.record("placetel.webhook", payload, {
          headers: selectedHeaders(req.headers),
        });
        return sendXml(res, 200, placetelControlXml(config.placetel));
      }

      return send(res, 404, { error: "Not found" });
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      // Only surface messages we deliberately marked safe (validation failures).
      // Everything else — including upstream SignalWire responses — is logged
      // server-side and returned generically to avoid leaking internal detail.
      if (error.expose) {
        return send(res, status, {
          error: error.message,
          ...(error.body ? { details: error.body } : {}),
        });
      }
      logInteraction("Request failed", { status, message: error.message });
      return send(res, status, {
        error: status >= 500 ? "Internal server error" : "Request failed",
      });
    }
  };
}

function serviceInfo(config) {
  return {
    name: "signalwire-placetel-tester",
    description:
      "Webhook-first SignalWire and Placetel round-trip calling tester.",
    endpoints: {
      health: endpointDoc({
        method: "GET",
        path: "/health",
        description: "Lightweight process health check. Does not place a call.",
        responses: {
          200: { ok: true, time: "2026-05-19T08:55:30.209Z" },
        },
      }),
      synchronousRoundTripCheck: endpointDoc({
        method: "GET",
        path: "/checks/round-trip",
        auth: "Required. Call creation is disabled when API_KEY is unset.",
        description:
          "Starts a real SignalWire call, waits for SignalWire and Placetel callbacks, and returns one monitor-friendly result.",
        query: {
          waitTimeoutMs: "Maximum time to hold the HTTP response open. Default: TEST_TIMEOUT_MS.",
          timeoutMs: "Round-trip test timeout. Default: TEST_TIMEOUT_MS.",
          waitForPlacetelWebhook: "Optional override. Use false when this tester cannot receive Placetel webhooks.",
          to: "Optional Placetel destination override. Default: DEFAULT_TO.",
          from: "Optional SignalWire caller ID override. Default: SIGNALWIRE_FROM.",
        },
        responses: {
          200: {
            ok: true,
            status: "ok",
            reason: "All required SignalWire and Placetel callbacks were received.",
            missing: [],
            test: "{ round-trip test object }",
          },
          503: {
            ok: false,
            status: "pending or failed",
            reason: "Waiting for or timed out waiting for required callbacks.",
            missing: ["signalWireTerminal"],
            test: "{ round-trip test object }",
          },
          400: {
            error: "Missing SignalWire configuration",
            details: { missing: ["SIGNALWIRE_FROM"] },
          },
        },
      }),
      initiateCall: endpointDoc({
        method: "POST",
        path: "/calls",
        auth: "Required. Call creation is disabled when API_KEY is unset.",
        description:
          "Creates a raw SignalWire outbound call and logs callbacks, without pass/fail round-trip evaluation.",
        body: {
          to: "Optional destination override. Default: DEFAULT_TO.",
          from: "Optional caller ID override. Default: SIGNALWIRE_FROM.",
        },
        responses: {
          201: {
            request: "{ SignalWire call request summary }",
            response: "{ SignalWire create-call response }",
          },
          400: {
            error: "Missing SignalWire configuration",
            missing: ["SIGNALWIRE_FROM"],
          },
        },
      }),
      startRoundTripTest: endpointDoc({
        method: "POST",
        path: "/tests",
        auth: "Required. Call creation is disabled when API_KEY is unset.",
        description:
          "Starts a real round-trip test and returns immediately with the initial test state.",
        body: {
          to: "Optional Placetel destination override. Default: DEFAULT_TO.",
          from: "Optional SignalWire caller ID override. Default: SIGNALWIRE_FROM.",
          timeoutMs: "Optional test timeout override.",
          waitForPlacetelWebhook: "Optional override. Use false when this tester cannot receive Placetel webhooks.",
        },
        responses: {
          201: {
            test: "{ status, expected checklist, missing checklist, events, SignalWire call SID }",
          },
        },
      }),
      listRoundTripTests: endpointDoc({
        method: "GET",
        path: "/tests",
        auth: "Required when API_KEY is configured.",
        description: "Lists in-memory round-trip tests, newest first.",
        responses: {
          200: {
            tests: ["{ round-trip test object }"],
          },
        },
      }),
      getRoundTripTest: endpointDoc({
        method: "GET",
        path: "/tests/{test_id}",
        auth: "Required when API_KEY is configured.",
        description: "Returns one round-trip test by ID.",
        responses: {
          200: {
            test: "{ round-trip test object }",
          },
          404: {
            error: "Test not found",
          },
        },
      }),
      listCalls: endpointDoc({
        method: "GET",
        path: "/calls",
        auth: "Required when API_KEY is configured.",
        description: "Lists observed call records and attached events.",
        responses: {
          200: {
            calls: ["{ call record }"],
          },
        },
      }),
      listEvents: endpointDoc({
        method: "GET",
        path: "/events",
        auth: "Required when API_KEY is configured.",
        description: "Lists recent webhook and call-creation events, newest first.",
        query: {
          limit: "Maximum event count. Default: 100.",
        },
        responses: {
          200: {
            events: ["{ event object }"],
          },
        },
      }),
      signalWireVoice: endpointDoc({
        method: "POST",
        path: "/webhooks/signalwire/voice",
        description:
          "SignalWire voice webhook. Logs the request and returns LaML/TwiML-compatible XML.",
        query: {
          test_id: "Optional round-trip test correlation ID.",
        },
        responses: {
          200: '<?xml version="1.0" encoding="UTF-8"?><Response><Say>...</Say><Hangup/></Response>',
        },
      }),
      signalWireStatus: endpointDoc({
        method: "POST",
        path: "/webhooks/signalwire/status",
        description: "SignalWire call-progress webhook receiver.",
        query: {
          test_id: "Optional round-trip test correlation ID.",
        },
        responses: {
          200: { ok: true, eventId: "uuid" },
        },
      }),
      placetel: endpointDoc({
        method: "POST",
        path: "/webhooks/placetel",
        description:
          "Placetel Call Control/Notify webhook receiver. Verifies HMAC when configured and returns Placetel XML control instructions.",
        responses: {
          200: '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup /></Response>',
          401: { error: "Invalid Placetel signature" },
        },
      }),
    },
    authentication: {
      apiKeyConfigured: Boolean(config.apiKey),
      protectedEndpoints: [
        "GET /",
        "GET /checks/round-trip",
        "POST /calls",
        "POST /tests",
        "GET /tests",
        "GET /tests/{test_id}",
        "GET /calls",
        "GET /events",
      ],
      acceptedMethods: [
        "Authorization: Bearer <API_KEY>",
        "X-API-Key: <API_KEY>",
      ],
      publicEndpoints: [
        "GET /health",
        "POST /webhooks/signalwire/status",
        "POST /webhooks/signalwire/voice",
        "POST /webhooks/placetel",
      ],
    },
    roundTripOkRequires: [
      "SignalWire call created",
      "At least one SignalWire status callback",
      "SignalWire terminal status: completed, busy, no-answer, failed, or canceled",
      "Placetel IncomingCall callback when WAIT_FOR_PLACETEL_WEBHOOK=true",
      "Placetel HungUp callback when WAIT_FOR_PLACETEL_WEBHOOK=true",
    ],
    configured: {
      apiKey: Boolean(config.apiKey),
      publicBaseUrl: Boolean(config.publicBaseUrl),
      signalWireBaseUrl: Boolean(config.signalWire.baseUrl),
      signalWireProjectId: Boolean(config.signalWire.projectId),
      signalWireToken: Boolean(config.signalWire.token),
      signalWireSigningKey: Boolean(config.signalWire.signingKey),
      signalWireFrom: Boolean(config.signalWire.from),
      signalWireVoiceWebhookUrl: Boolean(config.signalWire.voiceWebhookUrl),
      signalWireStatusWebhookUrl: Boolean(config.signalWire.statusWebhookUrl),
      placetelSharedSecret: Boolean(config.placetel.sharedSecret),
      waitForPlacetelWebhook: config.placetel.waitForWebhook,
      placetelAction: config.placetel.action,
      allowedToNumbers: config.allowedToNumbers.length,
      signalWireVerifyWebhooks: config.signalWire.verifyWebhooks,
    },
  };
}

function endpointDoc({ method, path, description, auth, query, body, responses }) {
  return {
    method,
    path,
    usage: `${method} ${path}`,
    description,
    ...(auth ? { auth } : {}),
    ...(query ? { query } : {}),
    ...(body ? { body } : {}),
    responses,
  };
}

async function startRoundTripTest({ body, config, store }) {
  const callInput = definedOnly({ to: body.to, from: body.from });
  const missing = requireSignalWireConfig(config, callInput);
  if (missing.length) {
    const error = new Error("Missing SignalWire configuration");
    error.status = 400;
    error.body = { missing };
    error.expose = true;
    throw error;
  }

  const to = callInput.to || config.signalWire.defaultTo;
  assertAllowedDestination(config, to);

  // Callback targets are derived from server config only; request-supplied URLs
  // are not honored so callbacks cannot be redirected to an arbitrary host.
  const voiceWebhookUrl =
    config.signalWire.voiceWebhookUrl ||
    `${config.publicBaseUrl}/webhooks/signalwire/voice`;
  const statusWebhookUrl =
    config.signalWire.statusWebhookUrl ||
    `${config.publicBaseUrl}/webhooks/signalwire/status`;
  const test = store.createTest({
    to,
    from: callInput.from || config.signalWire.from,
    timeoutMs: clampTimeout(body.timeoutMs, config.signalWire.testTimeoutMs),
    waitForPlacetelWebhook: booleanFromInput(
      body.waitForPlacetelWebhook,
      config.placetel.waitForWebhook,
    ),
  });

  const result = await createSignalWireCall(config, {
    ...callInput,
    statusCallback: appendQuery(statusWebhookUrl, "test_id", test.id),
    url: appendQuery(voiceWebhookUrl, "test_id", test.id),
  });

  const callSid = result.response.sid || result.response.call_sid;
  logInteraction("SignalWire call created for round-trip test", {
    testId: test.id,
    callSid,
    to: result.request.to,
    from: result.request.from,
    voiceWebhookUrl: result.request.url,
    statusWebhookUrl: result.request.statusCallback,
  });
  if (callSid) {
    store.upsertCall(callSid, {
      provider: "signalwire",
      request: result.request,
      response: result.response,
      testId: test.id,
      createdAt: new Date().toISOString(),
    });
  }

  store.markTestCallCreated(test.id, result);
  await store.record("signalwire.call.created", result.response, {
    request: result.request,
    testId: test.id,
  });

  return { test: store.getTest(test.id) };
}

async function waitForTest(store, testId, timeoutMs, pollMs = 250) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const test = store.getTest(testId);
    if (!test || test.status === "ok" || test.status === "failed") return test;
    await sleep(pollMs);
  }

  return store.getTest(testId);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function booleanFromInput(value, fallback) {
  if (value === undefined || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function appendQuery(rawUrl, key, value) {
  const url = new URL(rawUrl);
  url.searchParams.set(key, value);
  return url.toString();
}

function requiresApiKey(config, req, url) {
  if (!config.apiKey) return false;

  const publicRoutes = [
    ["GET", "/health"],
    ["POST", "/webhooks/signalwire/status"],
    ["POST", "/webhooks/signalwire/voice"],
    ["POST", "/webhooks/placetel"],
  ];

  return !publicRoutes.some(
    ([method, path]) => req.method === method && url.pathname === path,
  );
}

function isApiKeyAuthorized(config, req) {
  const header = req.headers.authorization || "";
  const bearerToken = header.startsWith("Bearer ")
    ? header.slice("Bearer ".length)
    : "";
  // Header-only: the key is never read from the query string, which would leak
  // it into proxy/access logs and browser history.
  const supplied = bearerToken || req.headers["x-api-key"] || "";
  return safeEqual(String(config.apiKey), String(supplied));
}

// Fail closed: refuse to place calls (toll-fraud surface) unless an API_KEY is set.
function requireApiKeyConfigured(config) {
  if (config.apiKey) return;
  const error = new Error("Server is not configured with an API_KEY; call creation is disabled.");
  error.status = 503;
  error.expose = true;
  throw error;
}

function isAllowedDestination(config, to) {
  if (!config.allowedToNumbers || config.allowedToNumbers.length === 0) return true;
  // Compare telephone numbers only; stripping digits from a SIP URI or dial
  // string could otherwise make a different destination resemble an allowed one.
  if (typeof to !== "string" || !/^\+?[\d ().-]+$/.test(to)) return false;
  return config.allowedToNumbers.some((allowed) => phoneMatches(allowed, to));
}

function assertAllowedDestination(config, to) {
  if (isAllowedDestination(config, to)) return;
  const error = new Error("Destination number is not in ALLOWED_TO_NUMBERS");
  error.status = 403;
  error.expose = true;
  error.body = { to: normalizePhone(to) };
  throw error;
}

// Drop undefined keys so callInput never clobbers config defaults when spread.
function definedOnly(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== undefined),
  );
}

function clampTimeout(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  const resolved = Number.isFinite(parsed) ? parsed : Number.parseInt(fallback, 10) || 0;
  return Math.min(Math.max(resolved, 0), MAX_TIMEOUT_MS);
}

// Verify inbound SignalWire webhooks when they reach this server directly.
// In "auto" mode an explicit SIGNALWIRE_*_WEBHOOK_URL means callbacks are routed
// through a proxy/flow and won't carry a signature this server can validate, so
// verification is skipped for that endpoint.
function signalWireVerifyEnabled(config, kind) {
  const mode = config.signalWire.verifyWebhooks;
  if (mode === "off") return false;
  if (mode === "on") return true;
  if (!signalWireSigningSecret(config) || !config.publicBaseUrl) return false;
  const override =
    kind === "voice"
      ? config.signalWire.voiceWebhookUrl
      : config.signalWire.statusWebhookUrl;
  return !override;
}

function signalWireSignatureOk(config, kind, req, payload) {
  if (!signalWireVerifyEnabled(config, kind)) return true;
  if (!signalWireSigningSecret(config) || !config.publicBaseUrl) return false;
  const fullUrl = `${config.publicBaseUrl}${req.url}`;
  return isValidSignalWireSignature(
    signalWireSigningSecret(config),
    fullUrl,
    payload,
    signalWireSignatureHeader(req.headers),
  );
}

function signalWireSigningSecret(config) {
  return config.signalWire.signingKey || config.signalWire.token;
}

function signalWireSignatureHeader(headers) {
  return headers["x-signalwire-signature"] || headers["x-twilio-signature"] || "";
}

async function readRequestBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const error = new Error("Request body too large");
      error.status = 413;
      error.expose = true;
      throw error;
    }
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return {
    raw,
    contentType: req.headers["content-type"] || "",
  };
}

function parseBody(input) {
  if (input.contentType.includes("application/json")) {
    return input.raw ? JSON.parse(input.raw) : {};
  }

  const params = new URLSearchParams(input.raw);
  return Object.fromEntries(params.entries());
}

function isValidPlacetelSignature(secret, rawBody, receivedSignature) {
  if (!secret) return true;
  if (!receivedSignature) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeEqual(expected, String(receivedSignature));
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function selectedHeaders(headers) {
  return {
    "content-type": headers["content-type"],
    "user-agent": headers["user-agent"],
    "x-placetel-signature": headers["x-placetel-signature"],
    "x-signalwire-signature": headers["x-signalwire-signature"],
    "x-twilio-signature": headers["x-twilio-signature"],
  };
}

function send(res, status, body, headers = {}) {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    ...headers,
  });
  res.end(data);
}

function sendXml(res, status, xml) {
  res.writeHead(status, {
    "Content-Type": "application/xml; charset=utf-8",
    "Content-Length": Buffer.byteLength(xml),
  });
  res.end(xml);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  if (!config.apiKey) {
    console.warn(
      "WARNING: API_KEY is not set. Call-creating endpoints are disabled and read endpoints are unauthenticated.",
    );
  }
  const server = http.createServer(createApp(config, store));
  server.listen(config.port, config.host, () => {
    console.log(
      `SignalWire/Placetel tester listening on http://${config.host}:${config.port}`,
    );
  });

  process.on("SIGTERM", () => {
    console.log("Received SIGTERM, shutting down HTTP server.");
    server.close(() => {
      process.exit(0);
    });
  });

  process.on("SIGINT", () => {
    console.log("Received SIGINT, shutting down HTTP server.");
    server.close(() => {
      process.exit(0);
    });
  });
}
