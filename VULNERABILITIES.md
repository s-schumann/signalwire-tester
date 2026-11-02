# Security Review — signalwire-placetel-tester

## Current recheck — 2026-11-02 (release 0.1.3)

The fresh scan of release 0.1.2 and the fresh rebuilt candidate both report
**0 critical, 0 high, 0 medium, 0 low, and 1 unspecified** finding. The sole
remaining finding is the same musl `CVE-2026-107891` version-threshold mismatch
documented below. The current Alpine security database still records r3 as fixed;
Node 22.23.4 remains the latest Node 22 patch. No new actionable package CVE was
identified. The base remains pinned; a build with `--pull --no-cache` rechecked
the runtime packages instead of reusing their upgrade layer.

This source recheck additionally fixes:

- Invalid Placetel HMAC requests previously wrote untrusted payloads into event
  and call history. They now return `401` without parsing or recording payloads.
- Provider requests had no application deadline or response body cap. They now
  time out across headers/body (default 15 s, configuration limited to 1..60000
  ms), cap responses at 256 KiB, and reject redirects. Upstream message text is
  no longer interpolated into logged errors. Network/size failures return `502`,
  deadlines return `504`, and failed creation leaves the associated test failed.
- Placetel payload `test_id` or `CallSid` fields could bypass phone matching.
  Exact correlation now uses only SignalWire metadata from server routes and
  requires agreement with a known call SID. Unknown explicit IDs do not fall
  back to a different test.
- Late callbacks could change timed-out tests into successes. Per-test callback
  attachment now enforces its creation/deadline window and active state.
- Importing `src/server.js` previously loaded `.env` even when tests supplied
  their own configuration. Only actual server startup now loads that file.

Validation passed: all 38 tests locally and in the amd64 scratch container,
static checks of all 16 source/test/script files, and the actual server smoke test.
The three correlation regression tests failed before the fixes and passed after.
Container tests use `--network none`, dummy credentials, and a local fake provider;
the live carrier path has not been rerun.

See `SECURITY_REVIEW.md` and `CLAUDE.md` for the independent review handoff.
The handoff explicitly identifies remaining retention/concurrency/proxy trust
questions; this review does not claim all application risks are resolved.

## Previous review — 2026-11-02 (release 0.1.2)

Scope: all application source, Node security advisories, the published amd64
image, the pinned Node base image, and the rebuilt scratch runtime. The app has
no npm dependencies. Tests use dummy credentials and a loopback provider; no
live SignalWire call is made by the automated container checks.

### Runtime CVEs

The previous published image index was
`sha256:ccfc1096896bece503a100001d31f6707a3dab04202c188f485a5e4389891237`
(release 0.1.1). Its Node version was 22.22.3. Docker Scout reported 27 Node
vulnerabilities: **1 critical, 10 high, 11 medium, 5 low**.

The Dockerfile now pins Node **22.23.4** on Alpine **3.24**, including the
[October Node security fixes](https://nodejs.org/en/blog/release/v22.23.4).
These address DNS validation, TLS hostname validation, HTTP connection reuse,
Brotli memory corruption, snapshot entropy reuse, and permission checks.
The [full upstream advisory](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)
also describes when each issue is exploitable; package findings alone do not
prove that every issue can be reached through this app.

Runtime library updates are applied before copying files into scratch. The final
image now retains Alpine OS metadata and package records for musl, libgcc,
libstdc++, and the certificate bundle. This lets scanners see copied libraries
that were absent from the old image's two-package SBOM. npm, npx, BusyBox,
shells, and the package manager remain absent.

Docker Scout 1.27.0 on the rebuilt runtime reports **0 critical, 0 high,
0 medium, 0 low, and 1 unspecified** finding. The remaining finding is a
verified false positive:

| Finding | Installed package | Scanner threshold | Upstream evidence |
| --- | --- | --- | --- |
| CVE-2026-107891 | Alpine 3.24 musl 1.2.6-r3 | Scout claims fixed in 1.2.6-r6 | Alpine's [security database](https://secdb.alpinelinux.org/v3.24/main.json) records the fix in 1.2.6-r3; its [APKBUILD](https://github.com/alpinelinux/aports/blob/8f79d39391b46d6dbf1800fb68b8212a21d5ee2e/main/musl/APKBUILD) includes `CVE-2026-107891.patch` and the matching `secfixes` entry. |

The package repository also offers 1.2.6-r3 as the latest revision. The finding
has not been hidden or suppressed, and the installed package version has not
been relabeled. Recheck Alpine's security database and raw scan on future builds.

### Application fixes

- **Destination allowlist and callback correlation bypass:** suffix matching
  accepted partial numbers such as `5000` for `+493023125000`. Matching now
  requires equality of full normalized numbers, including German national/E.164
  equivalents. Configured allowlists also reject SIP URIs and dial-control
  strings, which must not be normalized into an allowed telephone number.
- **Forced webhook verification failed open:** `SIGNALWIRE_VERIFY_WEBHOOKS=on`
  previously skipped verification when the signing secret or `PUBLIC_BASE_URL`
  was missing. Both SignalWire webhook endpoints now return `403` in that case.
  Existing `auto` and `off` routing behavior is preserved.

### Validation

- `npm run check` and all 25 Node tests pass.
- All 25 tests also pass under Node 22.23.4 in the amd64 scratch runtime.
- `scripts/smoke-container.mjs` exercises the actual server process in a
  container with external networking disabled: non-root execution, package
  metadata, excluded secrets/tools, HTTP API authentication, rejected unsigned
  webhooks, signed voice/status/Placetel callbacks, full round-trip `200`, missing
  callback `503`, destination rejection, XML responses, and clean SIGTERM.
- Scan all severities with `docker scout cves IMAGE`; do not claim an entirely
  empty raw report while the musl database mismatch remains.

The sections below preserve the earlier source review and remediation history.

---

Date: 2026-06-09
Scope: application source (`src/`), Dockerfile, configuration handling. This is a
source-level review and complements (does not replace) the Docker Scout dependency
scan. Scout checks the base image / packages; the findings below are logic and
design issues in the app itself, which Scout does not look at.

Severity scale: Critical / High / Medium / Low / Informational.

## Remediation status (2026-06-10)

All findings below have been addressed in code:

| ID | Finding | Status |
|----|---------|--------|
| H-1 | SSRF + credential exfil via body overrides | **Fixed** — credentials/base URL/callback URLs are config-only; body accepts only `to`/`from`. |
| H-2 | Open-by-default outbound calling | **Fixed** — call endpoints return `503` without `API_KEY`; `ALLOWED_TO_NUMBERS` destination allowlist added. |
| M-1 | No request body size limit | **Fixed** — 256 KB cap (`413` on exceed). |
| M-2 | Unsigned webhooks | **Partly fixed** — Placetel HMAC already enforced; SignalWire signature verification added, gated by `SIGNALWIRE_VERIFY_WEBHOOKS=auto\|on\|off` (`auto` = verify only when callbacks arrive directly). Proxy/flow deployments intentionally skip it. |
| M-3 | Client-controlled hold time | **Fixed** — `waitTimeoutMs`/`timeoutMs` clamped to 600000 ms. |
| L-1 | Internal error leakage | **Fixed** — only allowlisted validation errors are returned; upstream detail logged server-side. |
| L-2 | API key in query string | **Fixed** — header-only (`Authorization`/`X-API-Key`); query form removed. |
| L-3 | Unbounded event log | **Fixed** — rotates to one `.1` backup past 50 MB. |

Deployment note: in the proxy (WSEL) scenario, SignalWire callbacks are routed
through an external flow, so `SIGNALWIRE_VERIFY_WEBHOOKS=auto` correctly leaves
verification off there; in the direct scenario (no `SIGNALWIRE_*_WEBHOOK_URL`
override) it is verified against the configured `SIGNALWIRE_TOKEN`.

---

## H-1 (High): Server-Side Request Forgery + credential exfiltration via request-body overrides

`createSignalWireCall` lets the HTTP request body override the destination of the
outbound API call and the credentials/webhook URLs used:

```js
// src/signalwire.js
const baseUrl   = input.baseUrl   || config.signalWire.baseUrl;
const projectId = input.projectId || config.signalWire.projectId;
const token     = input.token     || config.signalWire.token;
...
const endpoint = `${baseUrl}/Accounts/${projectId}/Calls.json`;
const response = await fetch(endpoint, {
  headers: { Authorization: `Basic ${Buffer.from(`${projectId}:${token}`)...}` },
  ...
});
```

`input` is the parsed request body (`POST /calls`, `POST /tests`). An attacker who
can reach those endpoints can set `baseUrl` to a host they control. The server then
sends a request to that host **with the configured SignalWire token in the
`Authorization` header** — leaking the real API credentials. It is also a generic
SSRF primitive (the server will issue POST requests to arbitrary internal/external
URLs), useful for hitting cloud metadata endpoints or internal services.

Separately, `url`, `statusCallback`, and `publicBaseUrl` from the body flow into the
`Url`/`StatusCallback` parameters of the call (`startRoundTripTest`), so an attacker
can redirect SignalWire callbacks to an arbitrary host as well.

**Fix:** Do not accept `baseUrl`, `projectId`, `token` from the request body — take
them only from server config. Validate/allowlist `url`, `statusCallback`, and
`publicBaseUrl` against the configured `PUBLIC_BASE_URL` host (or drop them entirely
and always derive callbacks server-side).

---

## H-2 (High): Open by default — unauthenticated outbound calling (toll fraud)

Authentication is only enforced when `API_KEY` is set:

```js
// src/server.js
function requiresApiKey(config, req, url) {
  if (!config.apiKey) return false;   // no key configured => everything is public
  ...
}
```

`API_KEY` defaults to empty (`.env.example` ships it blank). With no key set, anyone
who can reach the service can call `POST /calls` / `POST /tests` to place **real
outbound phone calls** to an attacker-chosen `to` number, using your SignalWire
account and your money. Pointed at premium-rate / international numbers this is
classic toll fraud, and there is no rate limiting or destination allowlist.

The default `HOST=0.0.0.0` binds all interfaces, widening exposure if the container
port is published.

**Fix:** Fail closed — refuse to start (or refuse call-creating endpoints) when
`API_KEY` is unset. Add a destination allowlist for `to`, and rate-limit
call-creation. Document that the service must not be exposed publicly without a key.

---

## M-1 (Medium): No request body size limit — memory-exhaustion DoS

```js
// src/server.js
async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  ...
}
```

The full request body is buffered into memory with no cap. A single large POST (or
many concurrent ones) to any POST route — including the **unauthenticated** webhook
endpoints (`/webhooks/placetel`, `/webhooks/signalwire/*`) — can exhaust memory and
crash the process.

**Fix:** Enforce a maximum body size (e.g. reject once accumulated bytes exceed a
small limit like 64–256 KB) and abort the request.

---

## M-2 (Medium): Placetel webhook accepts unsigned requests when no secret is set

```js
// src/server.js
function isValidPlacetelSignature(secret, rawBody, receivedSignature) {
  if (!secret) return true;   // no secret => accept anything
  ...
}
```

If `PLACETEL_SHARED_SECRET` is unset (the default), the `/webhooks/placetel`
endpoint accepts any payload as authentic and records it / returns control XML.
Combined with no body-size limit (M-1), this is an unauthenticated write+DoS surface.
The SignalWire voice/status webhooks have no signature check at all, so they can be
spoofed to inject fake events into the in-memory store and influence round-trip test
results.

**Fix:** Require the shared secret (fail closed if unset) for `/webhooks/placetel`.
For SignalWire webhooks, validate the `X-SignalWire-Signature` (Twilio-compatible
HMAC) against the request URL + params.

---

## M-3 (Medium): Client-controlled long-lived hold time — connection exhaustion

`GET /checks/round-trip` holds the HTTP response open for a client-supplied duration:

```js
const waitTimeoutMs = Number.parseInt(body.waitTimeoutMs || body.timeoutMs || ..., 10);
const test = await waitForTest(store, result.test.id, waitTimeoutMs);
```

A caller can pass a very large `waitTimeoutMs` and open many such requests, tying up
sockets and timers. There is no upper bound and no concurrency limit.

**Fix:** Clamp `waitTimeoutMs`/`timeoutMs` to a sane maximum and cap concurrent
in-flight checks.

---

## L-1 (Low): Internal error details leaked in HTTP responses

```js
// src/server.js — top-level catch
return send(res, error.status || 500, {
  error: error.message || "Internal server error",
  details: error.body,
});
```

`error.body` carries the upstream SignalWire response body, and `error.message` can
include upstream messages (`SignalWire call creation failed: ...`). This can disclose
provider-side details, account/SID fragments, or internal state to the caller.

**Fix:** Return a generic message to clients; log the detail server-side only.

---

## L-2 (Low): API key accepted as a URL query parameter

```js
const supplied = bearerToken || req.headers["x-api-key"] || url.searchParams.get("api_key") || "";
```

Accepting `?api_key=` puts the secret into access logs, proxy logs, and browser
history. Prefer header-only auth; if the query form must stay, document the leakage
risk.

---

## L-3 (Low): Unbounded append-only event log on disk

`store.record` appends every event to `data/events.jsonl` forever with no rotation or
size cap. Over time, or under webhook flooding (M-1/M-2), this fills the disk. The
in-memory arrays are bounded (500 events), but the file is not.

**Fix:** Rotate/cap the log file, or make persistence opt-in.

---

## Positive notes

- **XML generation is safely escaped.** `xmlEscape` covers `& < > " '` and is applied
  to all interpolated values in `src/xml.js` (say message, forward targets, IDs,
  ringtime). No XML/markup injection found there.
- **Constant-time secret comparison.** `safeEqual` uses `crypto.timingSafeEqual` with
  a length pre-check, avoiding both timing leaks and the throw-on-unequal-length
  pitfall. Used for both the API key and the Placetel HMAC.
- **Secret redaction in logs.** `logger.js` redacts keys matching
  `token|secret|authorization|api[_-]?key` before console output.
- **Hardened container.** Final image is `FROM scratch`, runs as non-root
  (`USER 1000:1000`), and removes `npm`/`npx`, minimizing the runtime attack surface.
- **No secrets committed.** `.env` and `data/` are git-ignored; `data/events.jsonl`
  is not tracked.

---

## Suggested priority

1. H-1 — stop accepting `baseUrl`/`projectId`/`token`/callback URLs from request bodies (credential leak + SSRF).
2. H-2 — fail closed without `API_KEY`; add destination allowlist + rate limiting for call creation.
3. M-1 — cap request body size.
4. M-2 — require Placetel secret; validate SignalWire webhook signatures.
5. M-3, L-1, L-2, L-3 — hardening.
