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
- `SIGNALWIRE_VOICE_WEBHOOK_URL`: optional explicit voice/control callback URL for SignalWire. Use this when callbacks must route through a proxy.
- `SIGNALWIRE_STATUS_WEBHOOK_URL`: optional explicit status callback URL for SignalWire. Use this when callbacks must route through a proxy.
- `API_KEY`: optional shared key for non-webhook API endpoints.
- `SIGNALWIRE_BASE_URL`: the full SignalWire LaML API base URL, for example `https://{space}.signalwire.com/api/laml/2010-04-01`. This may point at a proxy.
- `SIGNALWIRE_PROJECT_ID`
- `SIGNALWIRE_TOKEN`
- `SIGNALWIRE_FROM`: a SignalWire-owned caller ID in E.164 format.
- `DEFAULT_TO`: the Placetel number to call, in E.164 format.
- `TEST_TIMEOUT_MS`: how long a round-trip test may wait before it is considered failed.
- `WAIT_FOR_PLACETEL_WEBHOOK`: set to `false` when this tester cannot receive Placetel webhooks because Placetel points to another tester URL.

If Placetel has a shared secret configured in External APIs, set `PLACETEL_SHARED_SECRET` so incoming Placetel requests are verified against `X-PLACETEL-SIGNATURE`.

## Run

```sh
npm start
```

The service listens on `http://0.0.0.0:3000` by default, which is suitable for Docker and most remote platforms.

Expose it publicly, then configure Placetel External APIs to call:

```txt
https://your-public-url/webhooks/placetel
```

SignalWire callback URLs default to:

```txt
{PUBLIC_BASE_URL}/webhooks/signalwire/voice
{PUBLIC_BASE_URL}/webhooks/signalwire/status
```

If SignalWire callbacks must go through a proxy, set them explicitly:

```env
SIGNALWIRE_VOICE_WEBHOOK_URL=https://proxy.example/signalwire/voice
SIGNALWIRE_STATUS_WEBHOOK_URL=https://proxy.example/signalwire/status
```

Round-trip tests append `test_id` to both URLs automatically.

## Docker

Build the image:

```sh
docker build -t signalwire-placetel-tester .
```

Build and publish the current production image:

```sh
git pull && docker buildx build \
  --platform linux/amd64 --provenance=true --sbom=true \
  --push -t schumann/signalwire-tester:latest \
  .
```

The production image builds from `node:22-alpine`, then publishes a `scratch`
runtime image containing only the Node binary, required shared libraries, CA
certificates, and the application files. This removes npm/npx, mitigating Docker
Scout finding `CVE-2026-33671` in npm's bundled `picomatch@4.0.3`. It also avoids
shipping Alpine's BusyBox package in the final image, which removes the remaining
BusyBox CVE from Scout.

To verify the Scout result:

```sh
docker scout cves schumann/signalwire-tester:latest
```

Run it with an env file:

```sh
docker run --rm -p 3000:3000 --env-file .env signalwire-placetel-tester
```

For a remote deployment, provide these environment variables through your platform secret/config mechanism:

```env
PORT=3000
HOST=0.0.0.0
API_KEY=change-me
PUBLIC_BASE_URL=https://your-public-host.example
SIGNALWIRE_VOICE_WEBHOOK_URL=
SIGNALWIRE_STATUS_WEBHOOK_URL=
SIGNALWIRE_BASE_URL=https://{space}.signalwire.com/api/laml/2010-04-01
SIGNALWIRE_PROJECT_ID=your-project-id
SIGNALWIRE_TOKEN=your-token
SIGNALWIRE_FROM=+496990009000
DEFAULT_TO=+493023125000
TEST_TIMEOUT_MS=120000
WAIT_FOR_PLACETEL_WEBHOOK=true
PLACETEL_SHARED_SECRET=your-placetel-secret
PLACETEL_ACTION=hangup
```

Persist `/app/data` as a volume if you want `events.jsonl` to survive container restarts:

```sh
docker run --rm -p 3000:3000 --env-file .env \
  -v signalwire-tester-data:/app/data \
  signalwire-placetel-tester
```

## API Index

`GET /` returns self-documenting JSON with:

- endpoint methods and paths
- endpoint purpose
- query/body parameters
- response status codes and example response bodies
- current configuration booleans, with secrets represented only as `true` or `false`

## API Authentication

When `API_KEY` is set, non-webhook API endpoints require authentication:

- `GET /`
- `GET /checks/round-trip`
- `POST /calls`
- `POST /tests`
- `GET /tests`
- `GET /tests/{test_id}`
- `GET /calls`
- `GET /events`

Webhook endpoints and `GET /health` remain public so SignalWire, Placetel, and platform health checks can reach them.

Preferred header:

```sh
curl -H 'Authorization: Bearer change-me' http://localhost:3000/tests
```

Also supported:

```sh
curl -H 'X-API-Key: change-me' http://localhost:3000/tests
curl 'http://localhost:3000/checks/round-trip?api_key=change-me&waitTimeoutMs=120000'
```

## Start A Round-Trip Test

This is the normal end-to-end check. It initiates a SignalWire call and marks the run `ok` only after all required callbacks arrive:

- SignalWire call created.
- At least one SignalWire status webhook.
- SignalWire terminal status webhook: `completed`, `busy`, `no-answer`, `failed`, or `canceled`.
- Placetel `IncomingCall` webhook.
- Placetel `HungUp` webhook.

If multiple testers share one Placetel account and only one of them can receive the Placetel webhook, set this on the other testers:

```env
WAIT_FOR_PLACETEL_WEBHOOK=false
```

In that mode the pass criteria become SignalWire-only: call created, at least one SignalWire status callback, and a terminal SignalWire status.

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
waitForPlacetelWebhook=false
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

The service also writes simple interaction logs to stdout for container logs, for example:

```txt
[2026-05-19T10:54:06.979Z] Starting synchronous round-trip check {"to":"+493023125000","from":"+496990009000"}
[2026-05-19T10:54:06.980Z] Received Placetel webhook {"event":"IncomingCall","from":"069200602148","to":"030515659470"}
```

## Notes

SignalWire call creation uses Basic auth with `project_id:token` and posts to:

```txt
{SIGNALWIRE_BASE_URL}/Accounts/{SIGNALWIRE_PROJECT_ID}/Calls.json
```

Placetel sends `application/x-www-form-urlencoded` POST requests and, when a shared secret is configured, signs the raw payload with HMAC-SHA256 in the `X-PLACETEL-SIGNATURE` header.
