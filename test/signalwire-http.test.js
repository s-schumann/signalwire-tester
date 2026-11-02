import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createSignalWireCall } from "../src/signalwire.js";

async function provider(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    publicBaseUrl: "http://127.0.0.1/callbacks",
    signalWire: {
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      projectId: "test-project", token: "test-token",
      from: "+496990009000", defaultTo: "+493023125000",
      requestTimeoutMs: 500,
    },
  };
}

test("SignalWire deadline covers both response headers and a stalled body", { timeout: 5000 }, async (t) => {
  for (const sendHeaders of [false, true]) {
    await t.test(sendHeaders ? "stalled body" : "no response", async (t) => {
      let received = false;
      const config = await provider(t, (req, res) => {
        received = true;
        req.resume();
        if (sendHeaders) {
          res.writeHead(201, { "Content-Type": "application/json" });
          res.write('{"sid":');
        }
      });
      await assert.rejects(createSignalWireCall(config, {}), { status: 504 });
      assert.equal(received, true);
    });
  }
});

test("SignalWire refuses redirects instead of resending authenticated call requests", async (t) => {
  let requests = 0;
  const config = await provider(t, (req, res) => {
    requests++;
    req.resume();
    if (req.url === "/redirected") {
      res.writeHead(201);
      res.end('{"sid":"unexpected"}');
    } else {
      res.writeHead(307, { Location: "/redirected" });
      res.end();
    }
  });
  config.signalWire.requestTimeoutMs = 2000;
  await assert.rejects(createSignalWireCall(config, {}), { status: 502 });
  assert.equal(requests, 1);
});

test("SignalWire rejects oversized response bodies", async (t) => {
  const config = await provider(t, (req, res) => {
    req.resume();
    res.writeHead(201);
    res.end("x".repeat(256 * 1024 + 1));
  });
  config.signalWire.requestTimeoutMs = 2000;
  await assert.rejects(createSignalWireCall(config, {}), { status: 502 });
});

test("SignalWire error messages omit arbitrary upstream response text", async (t) => {
  const config = await provider(t, (req, res) => {
    req.resume();
    res.writeHead(401);
    res.end(JSON.stringify({ message: "test-token must not be logged" }));
  });
  config.signalWire.requestTimeoutMs = 2000;
  await assert.rejects(createSignalWireCall(config, {}), (error) => {
    assert.equal(error.status, 401);
    assert.equal(error.message, "SignalWire call creation failed");
    return true;
  });
});
