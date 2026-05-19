import crypto from "node:crypto";
import http from "node:http";
import { URL } from "node:url";
import { loadDotEnv, readConfig, requireSignalWireConfig } from "./config.js";
import { createSignalWireCall } from "./signalwire.js";
import { EventStore } from "./store.js";
import { placetelControlXml, signalWireVoiceXml } from "./xml.js";

loadDotEnv();
const config = readConfig();
const store = new EventStore();

export function createApp(config, store) {
  return async function handle(req, res) {
    try {
      const url = new URL(req.url, "http://localhost");

      if (requiresAdminAuth(config, url.pathname) && !isAuthorized(config, req)) {
        return send(res, 401, { error: "Unauthorized" }, {
          "WWW-Authenticate": 'Basic realm="signalwire-placetel-tester"',
        });
      }

      if (req.method === "GET" && url.pathname === "/") {
        return send(res, 200, serviceInfo(config));
      }

      if (req.method === "GET" && url.pathname === "/health") {
        return send(res, 200, { ok: true, time: new Date().toISOString() });
      }

      if (req.method === "GET" && url.pathname === "/checks/round-trip") {
        const body = Object.fromEntries(url.searchParams.entries());
        const result = await startRoundTripTest({ body, config, store });
        const waitTimeoutMs = Number.parseInt(
          body.waitTimeoutMs || body.timeoutMs || config.signalWire.testTimeoutMs,
          10,
        );
        const test = await waitForTest(store, result.test.id, waitTimeoutMs);
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
        const input = await readRequestBody(req);
        const body = parseBody(input);
        const result = await startRoundTripTest({ body, config, store });
        return send(res, 201, result);
      }

      if (req.method === "POST" && url.pathname === "/calls") {
        const input = await readRequestBody(req);
        const body = parseBody(input);
        const missing = requireSignalWireConfig(config, body);
        if (missing.length) {
          return send(res, 400, {
            error: "Missing SignalWire configuration",
            missing,
          });
        }

        const result = await createSignalWireCall(config, body);
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
        return send(res, 201, result);
      }

      if (req.method === "POST" && url.pathname === "/webhooks/signalwire/status") {
        const input = await readRequestBody(req);
        const payload = parseBody(input);
        const event = await store.record("signalwire.status", payload, {
          headers: selectedHeaders(req.headers),
          testId: url.searchParams.get("test_id") || undefined,
        });
        return send(res, 200, { ok: true, eventId: event.id });
      }

      if (req.method === "POST" && url.pathname === "/webhooks/signalwire/voice") {
        const input = await readRequestBody(req);
        const payload = parseBody(input);
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
          await store.record("placetel.signature.invalid", parseBody(input), {
            headers: selectedHeaders(req.headers),
          });
          return send(res, 401, { error: "Invalid Placetel signature" });
        }

        const payload = parseBody(input);
        await store.record("placetel.webhook", payload, {
          headers: selectedHeaders(req.headers),
        });
        return sendXml(res, 200, placetelControlXml(config.placetel));
      }

      return send(res, 404, { error: "Not found" });
    } catch (error) {
      return send(res, error.status || 500, {
        error: error.message || "Internal server error",
        details: error.body,
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
        description:
          "Starts a real SignalWire call, waits for SignalWire and Placetel callbacks, and returns one monitor-friendly result.",
        query: {
          waitTimeoutMs: "Maximum time to hold the HTTP response open. Default: TEST_TIMEOUT_MS.",
          timeoutMs: "Round-trip test timeout. Default: TEST_TIMEOUT_MS.",
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
        description:
          "Creates a raw SignalWire outbound call and logs callbacks, without pass/fail round-trip evaluation.",
        body: {
          to: "Optional destination override. Default: DEFAULT_TO.",
          from: "Optional caller ID override. Default: SIGNALWIRE_FROM.",
          url: "Optional SignalWire voice webhook override.",
          statusCallback: "Optional SignalWire status callback override.",
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
        description:
          "Starts a real round-trip test and returns immediately with the initial test state.",
        body: {
          to: "Optional Placetel destination override. Default: DEFAULT_TO.",
          from: "Optional SignalWire caller ID override. Default: SIGNALWIRE_FROM.",
          timeoutMs: "Optional test timeout override.",
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
    roundTripOkRequires: [
      "SignalWire call created",
      "At least one SignalWire status callback",
      "SignalWire terminal status: completed, busy, no-answer, failed, or canceled",
      "Placetel IncomingCall callback",
      "Placetel HungUp callback",
    ],
    configured: {
      publicBaseUrl: Boolean(config.publicBaseUrl),
      signalWireBaseUrl: Boolean(config.signalWire.baseUrl),
      signalWireProjectId: Boolean(config.signalWire.projectId),
      signalWireToken: Boolean(config.signalWire.token),
      signalWireFrom: Boolean(config.signalWire.from),
      placetelSharedSecret: Boolean(config.placetel.sharedSecret),
      placetelAction: config.placetel.action,
    },
  };
}

function endpointDoc({ method, path, description, query, body, responses }) {
  return {
    method,
    path,
    usage: `${method} ${path}`,
    description,
    ...(query ? { query } : {}),
    ...(body ? { body } : {}),
    responses,
  };
}

async function startRoundTripTest({ body, config, store }) {
  const missing = requireSignalWireConfig(config, body);
  if (missing.length) {
    const error = new Error("Missing SignalWire configuration");
    error.status = 400;
    error.body = { missing };
    throw error;
  }

  const callbackBase = body.publicBaseUrl || config.publicBaseUrl;
  const test = store.createTest({
    to: body.to || config.signalWire.defaultTo,
    from: body.from || config.signalWire.from,
    timeoutMs: Number.parseInt(body.timeoutMs || config.signalWire.testTimeoutMs, 10),
  });

  const result = await createSignalWireCall(config, {
    ...body,
    statusCallback:
      body.statusCallback ||
      `${callbackBase}/webhooks/signalwire/status?test_id=${test.id}`,
    url:
      body.url ||
      `${callbackBase}/webhooks/signalwire/voice?test_id=${test.id}`,
  });

  const callSid = result.response.sid || result.response.call_sid;
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

function requiresAdminAuth(config, path) {
  if (!config.admin.username || !config.admin.password) return false;
  return path === "/calls" || path === "/events";
}

function isAuthorized(config, req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;
  const expected = `${config.admin.username}:${config.admin.password}`;
  const actual = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
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
  const server = http.createServer(createApp(config, store));
  server.listen(config.port, () => {
    console.log(`SignalWire/Placetel tester listening on http://localhost:${config.port}`);
  });
}
