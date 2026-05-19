import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export function loadDotEnv(path = join(root, ".env"), env = process.env) {
  if (!existsSync(path)) return;

  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    const value = unquote(trimmed.slice(separator + 1).trim());
    if (key && env[key] === undefined) env[key] = value;
  }
}

export function readConfig(env = process.env) {
  const port = numberFromEnv(env.PORT, 3000);
  const host = env.HOST || "0.0.0.0";
  const publicBaseUrl = cleanBaseUrl(env.PUBLIC_BASE_URL || "");

  return {
    port,
    host,
    apiKey: env.API_KEY || "",
    publicBaseUrl,
    signalWire: {
      baseUrl: cleanBaseUrl(env.SIGNALWIRE_BASE_URL || ""),
      projectId: env.SIGNALWIRE_PROJECT_ID || "",
      token: env.SIGNALWIRE_TOKEN || "",
      from: env.SIGNALWIRE_FROM || "",
      defaultTo: env.DEFAULT_TO || "",
      testTimeoutMs: numberFromEnv(env.TEST_TIMEOUT_MS, 120000),
      sayMessage:
        env.SIGNALWIRE_SAY_MESSAGE ||
        "SignalWire webhook test connected successfully.",
    },
    placetel: {
      waitForWebhook: booleanFromEnv(env.WAIT_FOR_PLACETEL_WEBHOOK, true),
      sharedSecret: env.PLACETEL_SHARED_SECRET || "",
      action: (env.PLACETEL_ACTION || "hangup").toLowerCase(),
      forwardTargets: splitList(env.PLACETEL_FORWARD_TARGETS || ""),
      forwardRingtime: numberFromEnv(env.PLACETEL_FORWARD_RINGTIME, 30),
      promptId: env.PLACETEL_PROMPT_ID || "",
      groupId: env.PLACETEL_GROUP_ID || "",
      routingPlanId: env.PLACETEL_ROUTING_PLAN_ID || "",
      queueId: env.PLACETEL_QUEUE_ID || "",
    },
  };
}

export function requireSignalWireConfig(config, overrides = {}) {
  const missing = [];
  const source = { ...config.signalWire, ...overrides };

  for (const key of ["baseUrl", "projectId", "token", "from"]) {
    if (!source[key]) missing.push(`SIGNALWIRE_${key.toUpperCase()}`);
  }

  if (!source.to && !config.signalWire.defaultTo) {
    missing.push("to or DEFAULT_TO");
  }

  if (!config.publicBaseUrl && !overrides.statusCallback && !overrides.url) {
    missing.push("PUBLIC_BASE_URL or explicit callback URLs");
  }

  return missing;
}

function cleanBaseUrl(value) {
  return value.replace(/\/+$/, "");
}

function splitList(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function numberFromEnv(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanFromEnv(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
