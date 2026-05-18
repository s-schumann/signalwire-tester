export function readConfig(env = process.env) {
  const port = numberFromEnv(env.PORT, 3000);
  const publicBaseUrl = cleanBaseUrl(env.PUBLIC_BASE_URL || "");

  return {
    port,
    publicBaseUrl,
    signalWire: {
      baseUrl: cleanBaseUrl(env.SIGNALWIRE_BASE_URL || ""),
      projectId: env.SIGNALWIRE_PROJECT_ID || "",
      token: env.SIGNALWIRE_TOKEN || "",
      from: env.SIGNALWIRE_FROM || "",
      defaultTo: env.DEFAULT_TO || "",
      sayMessage:
        env.SIGNALWIRE_SAY_MESSAGE ||
        "SignalWire webhook test connected successfully.",
    },
    placetel: {
      sharedSecret: env.PLACETEL_SHARED_SECRET || "",
      action: (env.PLACETEL_ACTION || "hangup").toLowerCase(),
      forwardTargets: splitList(env.PLACETEL_FORWARD_TARGETS || ""),
      forwardRingtime: numberFromEnv(env.PLACETEL_FORWARD_RINGTIME, 30),
      promptId: env.PLACETEL_PROMPT_ID || "",
      groupId: env.PLACETEL_GROUP_ID || "",
      routingPlanId: env.PLACETEL_ROUTING_PLAN_ID || "",
      queueId: env.PLACETEL_QUEUE_ID || "",
    },
    admin: {
      username: env.ADMIN_USERNAME || "",
      password: env.ADMIN_PASSWORD || "",
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
