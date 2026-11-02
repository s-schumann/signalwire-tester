// Run inside the built image with --network none and this directory mounted
// read-only at /app/scripts. The provider below only uses container loopback.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";

assert.equal(process.getuid(), 1000);
assert.equal(process.version, "v22.23.4");
for (const path of ["/bin/sh", "/usr/local/bin/npm", "/app/.env", "/app/.git"]) {
  assert.equal(existsSync(path), false, `${path} must not be shipped`);
}
const packages = readFileSync("/lib/apk/db/installed", "utf8");
assert.deepEqual([...packages.matchAll(/^P:(.+)$/gm)].map((m) => m[1]).sort(),
  ["ca-certificates-bundle", "libgcc", "libstdc++", "musl"]);
assert.match(packages, /P:musl\nV:\d+\.\d+\.\d+-r\d+/);

const apiKey = "container-test-key";
const signingKey = "container-signing-key";
const placetelSecret = "container-placetel-secret";
const destination = "+493023125000";
let callCount = 0;
let completeCallbacks = true;
const callbackTasks = [];
const provider = http.createServer(async (req, res) => {
  try {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/Accounts/test-project/Calls.json");
    assert.equal(req.headers.authorization,
      `Basic ${Buffer.from("test-project:test-token").toString("base64")}`);
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const params = new URLSearchParams(raw);
    const sid = `SW-SMOKE-${++callCount}`;
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sid }));
    if (completeCallbacks) callbackTasks.push(deliverCallbacks(params, sid));
  } catch (error) {
    res.writeHead(500);
    res.end();
    callbackTasks.push(Promise.resolve(error));
  }
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const probe = http.createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["src/server.js"], {
  env: {
    ...process.env,
    PORT: String(port), HOST: "127.0.0.1", PUBLIC_BASE_URL: baseUrl,
    API_KEY: apiKey, SIGNALWIRE_BASE_URL: `http://127.0.0.1:${provider.address().port}`,
    SIGNALWIRE_PROJECT_ID: "test-project", SIGNALWIRE_TOKEN: "test-token",
    SIGNALWIRE_SIGNING_KEY: signingKey, SIGNALWIRE_FROM: "+496990009000",
    DEFAULT_TO: destination, ALLOWED_TO_NUMBERS: destination,
    SIGNALWIRE_VERIFY_WEBHOOKS: "on", SIGNALWIRE_VOICE_WEBHOOK_URL: "",
    SIGNALWIRE_STATUS_WEBHOOK_URL: "", WAIT_FOR_PLACETEL_WEBHOOK: "true",
    PLACETEL_SHARED_SECRET: placetelSecret, PLACETEL_ACTION: "hangup",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });

async function request(path, options = {}, auth = true) {
  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { ...(auth ? { Authorization: `Bearer ${apiKey}` } : {}), ...options.headers },
    signal: AbortSignal.timeout(5000),
  });
}

async function deliverCallbacks(params, sid) {
  try {
    await delay(30);
    for (const [url, fields] of [
      [params.get("Url"), { CallSid: sid, CallStatus: "in-progress" }],
      [params.get("StatusCallback"), { CallSid: sid, CallStatus: "completed" }],
    ]) {
      const data = Object.keys(fields).sort().reduce((acc, key) => acc + key + fields[key], url);
      const signature = crypto.createHmac("sha1", signingKey).update(data).digest("base64");
      const response = await fetch(url, {
        method: "POST", headers: { "X-SignalWire-Signature": signature },
        body: new URLSearchParams(fields), signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, 200);
      if (url.includes("/voice")) assert.match(await response.text(), /<Hangup\/>/);
    }
    for (const event of ["IncomingCall", "HungUp"]) {
      const body = new URLSearchParams({
        event, call_id: sid, to: "03023125000", from: "06990009000",
      }).toString();
      const response = await request("/webhooks/placetel", {
        method: "POST", body,
        headers: { "Content-Type": "application/x-www-form-urlencoded",
          "X-Placetel-Signature": crypto.createHmac("sha256", placetelSecret).update(body).digest("hex") },
      }, false);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /<Hangup \/>/);
    }
  } catch (error) { return error; }
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { ready = (await request("/health", {}, false)).ok; } catch {}
    if (ready) break;
    await delay(30);
  }
  assert.equal(ready, true, output);
  assert.equal((await request("/tests", {}, false)).status, 401);
  assert.equal((await request("/", {}, true)).status, 200);
  for (const path of ["signalwire/status", "signalwire/voice", "placetel"]) {
    const response = await request(`/webhooks/${path}`, { method: "POST", body: "event=IncomingCall" }, false);
    assert.equal(response.status, path === "placetel" ? 401 : 403);
  }
  const blocked = await request("/calls", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to: "5000" }),
  });
  assert.equal(blocked.status, 403);
  assert.equal(callCount, 0);
  const success = await request("/checks/round-trip?waitTimeoutMs=3000");
  assert.equal(success.status, 200, await success.clone().text());
  const result = await success.json();
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
  assert.equal(result.test.events.length, 5);
  completeCallbacks = false;
  const timeout = await request("/checks/round-trip?timeoutMs=50&waitTimeoutMs=300");
  assert.equal(timeout.status, 503);
  assert.equal((await timeout.json()).ok, false);
  for (const task of callbackTasks) assert.equal(await task, undefined);
  assert.equal(callCount, 2);
  console.log("Container smoke passed: non-root runtime, package metadata, API auth, signed callbacks, full round-trip success, timeout, allowlist, and XML.");
} finally {
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const force = setTimeout(() => child.kill("SIGKILL"), 2000);
  const [code] = await exited;
  clearTimeout(force);
  await new Promise((resolve) => provider.close(resolve));
  assert.equal(code, 0, output);
}
