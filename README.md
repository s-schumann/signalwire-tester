# SignalWire Placetel Tester

Small webhook-first test service for end-to-end SignalWire outbound calls into a Placetel-controlled receiving number.

It provides:

- `POST /calls` to initiate a SignalWire Compatibility API call.
- `POST /tests` to initiate a full round-trip test and evaluate required callbacks.
- `GET /checks/round-trip` to synchronously run the full check for uptime monitors.
- `POST /webhooks/signalwire/status` to receive all requested SignalWire call status callbacks.
- `POST /webhooks/signalwire/voice` to return LaML/TwiML-compatible XML when the SignalWire call is answered.
- `POST /webhooks/placetel` to receive Placetel Call Control/Notify API events and return Placetel XML control instructions.
- `GET /tests`, `GET /events`, and `GET /calls` to inspect what happened during a test run.

## Setup

```sh
cp .env.example .env
```

Fill in:

- `PUBLIC_BASE_URL`: the public HTTPS URL that SignalWire and Placetel can reach, for example an ngrok URL.
- `SIGNALWIRE_BASE_URL`: your SignalWire space URL, for example `https://{space}.signalwire.com/api/laml/2010-04-01`.
- `SIGNALWIRE_PROJECT_ID`
- `SIGNALWIRE_TOKEN`
- `SIGNALWIRE_FROM`: a SignalWire-owned caller ID in E.164 format.
- `DEFAULT_TO`: the Placetel number to call, in E.164 format.
- `TEST_TIMEOUT_MS`: how long a round-trip test may wait before it is considered failed.

If Placetel has a shared secret configured in External APIs, set `PLACETEL_SHARED_SECRET` so incoming Placetel requests are verified against `X-PLACETEL-SIGNATURE`.

## Run

```sh
npm start
```

The service listens on `http://localhost:3000` by default.

Expose it publicly, then configure Placetel External APIs to call:

```txt
https://your-public-url/webhooks/placetel
```

## Start A Round-Trip Test

This is the normal end-to-end check. It initiates a SignalWire call and marks the run `ok` only after all required callbacks arrive:

- SignalWire call created.
- At least one SignalWire status webhook.
- SignalWire terminal status webhook: `completed`, `busy`, `no-answer`, `failed`, or `canceled`.
- Placetel `IncomingCall` webhook.
- Placetel `HungUp` webhook.

With defaults from `.env`:

```sh
curl -X POST http://localhost:3000/tests \
  -H 'Content-Type: application/json' \
  -d '{}'
```

With explicit call values:

```sh
curl -X POST http://localhost:3000/tests \
  -H 'Content-Type: application/json' \
  -d '{
    "to": "+492214710000",
    "from": "+493023125001"
  }'
```

Inspect test status:

```sh
curl http://localhost:3000/tests
curl http://localhost:3000/tests/{test_id}
```

## Synchronous Monitor Endpoint

For Uptime Kuma or any HTTP monitor that needs a single request/response, use:

```txt
GET http://localhost:3000/checks/round-trip
```

The endpoint starts a real SignalWire call, waits for the SignalWire and Placetel callbacks, then returns:

- `200` with `"ok": true` when the full round trip passes.
- `503` with `"ok": false` when required callbacks are missing before timeout.
- `400` when required configuration is missing.

Optional query parameters:

```txt
waitTimeoutMs=120000
timeoutMs=120000
to=+493023125000
from=+496990009000
```

## Start A Raw Call

With defaults from `.env`:

```sh
curl -X POST http://localhost:3000/calls \
  -H 'Content-Type: application/json' \
  -d '{}'
```

With explicit call values:

```sh
curl -X POST http://localhost:3000/calls \
  -H 'Content-Type: application/json' \
  -d '{
    "to": "+492214710000",
    "from": "+493023125001"
  }'
```

The call request sends SignalWire these callback URLs unless overridden in the request:

- `Url`: `${PUBLIC_BASE_URL}/webhooks/signalwire/voice`
- `StatusCallback`: `${PUBLIC_BASE_URL}/webhooks/signalwire/status`

It requests these status callback events:

- `initiated`
- `ringing`
- `answered`
- `completed`
- `ringing_forwarded`
- `ringing_queued`

## Placetel Control

Set `PLACETEL_ACTION` in `.env`:

- `hangup`: return `<Hangup />`.
- `reject`: return `<Reject />`.
- `busy`: return `<Reject reason="busy" />`.
- `forward`: forward to comma-separated `PLACETEL_FORWARD_TARGETS`.
- `prompt`: play `PLACETEL_PROMPT_ID`.
- `group`: route to `PLACETEL_GROUP_ID`.
- `routing_plan`: route to `PLACETEL_ROUTING_PLAN_ID`.
- `queue`: route to `PLACETEL_QUEUE_ID`.

Example forwarding config:

```env
PLACETEL_ACTION=forward
PLACETEL_FORWARD_TARGETS=7777abcdefg@fpbx.de,03023125001
PLACETEL_FORWARD_RINGTIME=30
```

## Inspect Results

```sh
curl http://localhost:3000/tests
curl http://localhost:3000/events
curl http://localhost:3000/calls
```

Events are also appended to `data/events.jsonl`.

## Notes

SignalWire call creation uses Basic auth with `project_id:token` and posts to:

```txt
{SIGNALWIRE_BASE_URL}/api/laml/2010-04-01/Accounts/{SIGNALWIRE_PROJECT_ID}/Calls.json
```

Placetel sends `application/x-www-form-urlencoded` POST requests and, when a shared secret is configured, signs the raw payload with HMAC-SHA256 in the `X-PLACETEL-SIGNATURE` header.
