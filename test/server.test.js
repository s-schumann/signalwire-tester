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

function createTestRequest(env) {
  const config = readConfig({ PORT: "0", ...env });
  const app = createApp(config, new EventStore());

  return async function request(path, options = {}) {
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
  };
}

function normalizeHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
}
