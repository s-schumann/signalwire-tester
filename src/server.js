import crypto from "node:crypto";
import http from "node:http";
import { URL } from "node:url";
import { readConfig, requireSignalWireConfig } from "./config.js";
import { createSignalWireCall } from "./signalwire.js";
import { EventStore } from "./store.js";
import { placetelControlXml, signalWireVoiceXml } from "./xml.js";

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

      if (req.method === "GET" && url.pathname === "/events") {
        const limit = Number.parseInt(url.searchParams.get("limit") || "100", 10);
        return send(res, 200, { events: store.listEvents(limit) });
      }

      if (req.method === "GET" && url.pathname === "/calls") {
        return send(res, 200, { calls: store.listCalls() });
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
        });
        return send(res, 200, { ok: true, eventId: event.id });
      }

      if (req.method === "POST" && url.pathname === "/webhooks/signalwire/voice") {
        const input = await readRequestBody(req);
        const payload = parseBody(input);
        await store.record("signalwire.voice", payload, {
          headers: selectedHeaders(req.headers),
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
    endpoints: {
      health: "GET /health",
      initiateCall: "POST /calls",
      listCalls: "GET /calls",
      listEvents: "GET /events?limit=100",
      signalWireVoice: "POST /webhooks/signalwire/voice",
      signalWireStatus: "POST /webhooks/signalwire/status",
      placetel: "POST /webhooks/placetel",
    },
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
