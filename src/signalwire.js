export async function createSignalWireCall(config, input) {
  // Credentials and the API base URL come only from server config — never from
  // request input — so a caller cannot redirect the authenticated request to an
  // arbitrary host or exfiltrate the SignalWire token (SSRF / credential leak).
  const baseUrl = config.signalWire.baseUrl;
  const projectId = config.signalWire.projectId;
  const token = config.signalWire.token;
  const from = input.from || config.signalWire.from;
  const to = input.to || config.signalWire.defaultTo;

  const url =
    input.url ||
    config.signalWire.voiceWebhookUrl ||
    `${config.publicBaseUrl}/webhooks/signalwire/voice`;
  const statusCallback =
    input.statusCallback ||
    config.signalWire.statusWebhookUrl ||
    `${config.publicBaseUrl}/webhooks/signalwire/status`;

  const params = new URLSearchParams({
    To: to,
    From: from,
    Url: url,
    Method: "POST",
    StatusCallback: statusCallback,
    StatusCallbackMethod: "POST",
  });

  const events = input.statusCallbackEvents || [
    "initiated",
    "ringing",
    "answered",
    "completed",
    "ringing_forwarded",
    "ringing_queued",
  ];
  for (const event of events) params.append("StatusCallbackEvent", event);

  for (const [key, value] of Object.entries(input.extra || {})) {
    if (value !== undefined && value !== null && value !== "") {
      params.append(key, String(value));
    }
  }

  const endpoint = `${baseUrl}/Accounts/${projectId}/Calls.json`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${projectId}:${token}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: params,
  });

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }

  if (!response.ok) {
    const message = body?.message || body?.error || text || response.statusText;
    const error = new Error(`SignalWire call creation failed: ${message}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return {
    request: {
      to,
      from,
      url,
      statusCallback,
      statusCallbackEvents: events,
    },
    response: body,
  };
}
