import assert from "node:assert/strict";
import test from "node:test";
import { createSignalWireCall } from "../src/signalwire.js";

test("SignalWire base URL is the full LaML API base path", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl;

  globalThis.fetch = async (url) => {
    requestedUrl = url;
    return new Response(JSON.stringify({ sid: "SW123" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    await createSignalWireCall(
      {
        publicBaseUrl: "https://tester.example",
        signalWire: {
          baseUrl: "https://proxy.example/signalwire/api/laml/2010-04-01",
          projectId: "project-id",
          token: "token",
          from: "+493023125001",
          defaultTo: "+12025550101",
        },
      },
      {},
    );

    assert.equal(
      requestedUrl,
      "https://proxy.example/signalwire/api/laml/2010-04-01/Accounts/project-id/Calls.json",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("SignalWire callback URLs can come from explicit config", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;

  globalThis.fetch = async (_url, options) => {
    requestBody = options.body;
    return new Response(JSON.stringify({ sid: "SW123" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    await createSignalWireCall(
      {
        publicBaseUrl: "https://tester.example",
        signalWire: {
          baseUrl: "https://signalwire.example/api/laml/2010-04-01",
          projectId: "project-id",
          token: "token",
          from: "+493023125001",
          defaultTo: "+12025550101",
          voiceWebhookUrl: "https://proxy.example/voice",
          statusWebhookUrl: "https://proxy.example/status",
        },
      },
      {},
    );

    assert.equal(requestBody.get("Url"), "https://proxy.example/voice");
    assert.equal(requestBody.get("StatusCallback"), "https://proxy.example/status");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
