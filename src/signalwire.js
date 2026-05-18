export async function createSignalWireCall(config, input) {
  const baseUrl = input.baseUrl || config.signalWire.baseUrl;
  const projectId = input.projectId || config.signalWire.projectId;
  const token = input.token || config.signalWire.token;
  const from = input.from || config.signalWire.from;
  const to = input.to || config.signalWire.defaultTo;

  const callbackBase = input.publicBaseUrl || config.publicBaseUrl;
  const url = input.url || `${callbackBase}/webhooks/signalwire/voice`;
  const statusCallback =
    input.statusCallback || `${callbackBase}/webhooks/signalwire/status`;

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

  const endpoint = `${baseUrl}/api/laml/2010-04-01/Accounts/${projectId}/Calls.json`;
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
