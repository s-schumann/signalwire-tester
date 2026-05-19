# Agent Handoff

## Project

This repo contains a small dependency-free Node.js service for testing an end-to-end SignalWire to Placetel call path.

The main goal is to verify that a real outbound SignalWire call reaches the Placetel number and that all required webhooks are received. Later work may add alerting, but currently the service logs and exposes pass/fail status.

## Runtime

- Node.js >= 20
- No npm runtime dependencies
- Entry point: `src/server.js`
- Start command: `npm start`
- Test command: `npm test`
- Default port: `3000`

The app loads `.env` automatically from the repo root before reading config.

## Important Files

- `src/server.js`: HTTP routes, webhook handlers, synchronous check endpoint.
- `src/store.js`: in-memory events, calls, round-trip test state, correlation and pass/fail evaluation.
- `src/signalwire.js`: SignalWire Compatibility API call creation.
- `src/xml.js`: SignalWire voice XML and Placetel control XML.
- `src/config.js`: `.env` loader and config normalization.
- `test/`: Node test runner coverage.
- `README.md`: user-facing setup, API, Docker, and operations docs.
- `Dockerfile`: production container image definition.
- `.env.example`: config template.

## Secrets And Local Config

`.env` is intentionally ignored by git. Do not commit it.

Current local `.env` includes live SignalWire and Placetel values. Treat it as sensitive.

Required deployment variables:

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

`PUBLIC_BASE_URL` must be reachable by both SignalWire and Placetel. Placetel should be configured to call:

```txt
{PUBLIC_BASE_URL}/webhooks/placetel
```

If SignalWire callbacks route through a proxy, set `SIGNALWIRE_VOICE_WEBHOOK_URL` and `SIGNALWIRE_STATUS_WEBHOOK_URL` explicitly. Round-trip tests append `test_id` to both URLs.

When `API_KEY` is configured, non-webhook API endpoints require one of:

- `Authorization: Bearer <API_KEY>`
- `X-API-Key: <API_KEY>`
- `api_key=<API_KEY>` query parameter

Webhook endpoints and `GET /health` intentionally remain public.

## Key Endpoints

- `GET /`: self-documenting API index with endpoint descriptions and response examples.
- `GET /health`: process health only, no phone call.
- `GET /checks/round-trip`: synchronous monitor endpoint for Uptime Kuma. Starts a real call and waits for callbacks. Returns `200` on pass, `503` on missing callbacks or timeout.
- `POST /tests`: starts a real round-trip test and returns immediately.
- `GET /tests`: lists round-trip test state.
- `GET /tests/{test_id}`: returns one test.
- `POST /calls`: raw SignalWire call creation without pass/fail test evaluation.
- `POST /webhooks/signalwire/status`: SignalWire call-progress callback.
- `POST /webhooks/signalwire/voice`: SignalWire voice callback, returns XML.
- `POST /webhooks/placetel`: Placetel webhook, verifies HMAC when `PLACETEL_SHARED_SECRET` is set, returns Placetel XML control.

## Round-Trip Pass Criteria

A test is `ok` only when all of these are observed:

- SignalWire call was created.
- At least one SignalWire status callback was received.
- A terminal SignalWire status was received: `completed`, `busy`, `no-answer`, `failed`, or `canceled`.
- Placetel `IncomingCall` callback was received.
- Placetel `HungUp` callback was received.

If `WAIT_FOR_PLACETEL_WEBHOOK=false`, the Placetel callback requirements are removed from pass/fail evaluation. This supports running multiple testers when Placetel can only point to one webhook URL. `GET /checks/round-trip` and `POST /tests` can also override this per run with `waitForPlacetelWebhook=false`.

SignalWire callback URLs for tests include `?test_id=...` for exact correlation. Placetel has no test ID, so Placetel events are correlated by call timing plus normalized `to` and `from` numbers. German national formats such as `030...` and `069...` are matched against E.164 `+4930...` and `+4969...`.

## Operational Notes

Current Placetel behavior is `PLACETEL_ACTION=hangup`, so the receiving side immediately hangs up. In this flow SignalWire may report `completed` or `busy` depending on call timing and Placetel behavior. Both are accepted as terminal statuses.

Events are stored in memory and appended to:

```txt
data/events.jsonl
```

The service writes simple interaction logs to stdout for container logs: test start/finish, raw call creation, SignalWire webhooks, and Placetel webhooks. Secrets are redacted by key name.

`data/` is gitignored. For Docker deployments, mount `/app/data` if logs must survive restarts.

## Docker

Build:

```sh
docker build -t signalwire-placetel-tester .
```

Run:

```sh
docker run --rm -p 3000:3000 --env-file .env signalwire-placetel-tester
```

Persistent logs:

```sh
docker run --rm -p 3000:3000 --env-file .env \
  -v signalwire-tester-data:/app/data \
  signalwire-placetel-tester
```

Docker was not available in the local Codex environment when this file was written, so the Dockerfile was not built locally. `npm test` passed.

## Development Constraints

- Keep the app dependency-free unless there is a clear need.
- Do not expose secrets in `GET /`; represent configured secrets only as booleans.
- Keep inbound webhooks unauthenticated by `API_KEY`; Placetel authentication is HMAC-based.
- Do not commit `.env` or `data/`.
- Use Node's built-in test runner.
- Prefer focused tests around webhook correlation and endpoint response codes.
- If changing Placetel XML actions, verify expected XML in `test/xml.test.js`.

## Useful Commands

```sh
npm test
npm start
curl 'http://localhost:3000/checks/round-trip?waitTimeoutMs=120000'
curl http://localhost:3000/tests
curl http://localhost:3000/events
```

When using zsh, quote URLs containing `?`, for example:

```sh
curl 'http://localhost:3000/checks/round-trip?waitTimeoutMs=10000'
```

## Recent Known-Good State

The service has successfully completed real round-trip tests from SignalWire `+496990009000` to Placetel `+493023125000`.

Latest relevant commits at handoff:

```txt
310bd0f Document API index and add Dockerfile
1ea6ec7 Add synchronous round trip check
6a24d5b Accept terminal SignalWire statuses
```
