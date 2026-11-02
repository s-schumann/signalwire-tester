# Independent Claude Code security review

Prepared: 2026-11-02. Review target: release `v0.1.3` / current `HEAD`.
Change baseline: `v0.1.2` (`199822fdf484415245fb73ae335a6e9952cc6025`).
This brief prepares a review; it does not represent a completed Claude review.

## Review request

Review the complete current source and container configuration for exploitable
security defects. Inspect `git diff v0.1.2...HEAD`, but also examine unchanged
code. Validate past remediation claims independently. Distinguish package CVEs,
application logic issues, and deployment-dependent risks.

For each confirmed finding, report severity, file and line, untrusted input,
exploit preconditions, impact, a dummy-data reproduction or failing test, and a
focused fix. Prioritize observable behavior over hypothetical attack chains.
List unanswered questions and coverage gaps separately. Keep the initial review
read-only; changes and release publication are separate work.

## Application and trust boundaries

- `src/server.js`: API-key-protected management/call routes; public health and
  provider webhook routes; body size limit; signature verification and XML.
- `src/signalwire.js`: authenticated outbound call creation. Credentials, base
  URL, and callback targets come from server configuration. HTTP inputs accept
  only `to`/`from`, plus documented test options.
- `src/store.js`: in-memory call/test/event state, callback correlation,
  deadlines, and JSONL persistence/rotation.
- `src/config.js`, `src/signature.js`, `src/logger.js`, `src/xml.js`: environment
  loading, cryptography, stdout redaction, and XML escaping.
- `Dockerfile`, `.dockerignore`: pinned Node 22.23.4 / Alpine 3.24 builder,
  updated runtime libraries, non-root scratch runtime, retained package records.
- `test/` and `scripts/smoke-container.mjs`: dummy-data verification fixtures.

API_KEY protects management endpoints. Call creation returns `503` without it.
Placetel HMAC is enforced when its shared secret is configured. SignalWire
`on` requires valid signatures and its configuration; `auto` skips checks when
credentials/public URL are missing or an endpoint has a proxy override; `off`
disables checks. These modes are existing deployment choices, not proof of
authenticity. Treat the reverse proxy and its authentication as a separate trust
boundary. No proxy configuration is in this repository.

## Fixes to challenge in this release

- Invalid Placetel signatures return `401` before parsing or recording payloads.
- Provider requests refuse redirects, cap response bodies at 256 KiB, and use a
  deadline covering headers and body (default 15000 ms, configuration 1..60000).
  Failures return generic errors; provider-controlled messages are not logged.
- Failed call creation leaves a failed test rather than a permanently starting
  test. No retry is automatic, since call creation may have succeeded remotely
  even when its response times out.
- Only server-generated SignalWire event metadata supplies exact test IDs.
  A known call SID must agree with that ID; unknown explicit IDs never fall back
  to another test. Placetel payload IDs cannot bypass phone-number correlation.
- Callbacks outside the test deadline cannot turn a timeout into a pass.
- API-index fixtures verify secrets appear only as configured booleans.
- Importing the HTTP handler for tests/review does not load the local `.env`;
  environment-file loading occurs only at normal server startup.

## Open questions and operational limits

These are review targets, not claims that all are independently exploitable:

- `EventStore.calls`, `EventStore.tests`, and per-record event histories have no
  total retention cap. Only the top-level event array and on-disk log have caps.
  Assess resource exhaustion, signed replay, and long-running monitor retention.
- There is no application-level call rate or concurrency limit. Assess resource
  use and spending under compromised API credentials and proxy arrangements.
- Simultaneous tests of the same number pair may share indistinguishable
  Placetel events; missing caller numbers are accepted for provider compatibility.
  Assess incorrect success attribution and how to avoid it.
- Evaluate client disconnects during synchronous waits, concurrent log rotation,
  malformed/duplicate form fields, and missing/invalid provider response IDs.
- Assess storing raw authenticated webhook payloads and signatures in JSONL and
  the filesystem access controls required for those operational records.

## Current CVE evidence

The fresh scan of published `v0.1.2` (index digest
`sha256:8b66ed3726f7772aafc2d330e18c1492182bfa715ebdfdc683c7fb300079a182`)
and the fresh candidate build both report 0 critical, 0 high, 0 medium, 0 low,
and 1 unspecified finding in Docker Scout 1.27.0. No new actionable package CVE
was found relative to the earlier review. The [Node release index](https://nodejs.org/dist/index.json)
still identifies 22.23.4 as the latest Node 22 patch; see the
[October advisory](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases).

The remaining finding is `CVE-2026-107891` for musl 1.2.6-r3. Scout requests r6;
Alpine's [security database](https://secdb.alpinelinux.org/v3.24/main.json) records
the fix at r3, and the [package source](https://github.com/alpinelinux/aports/blob/8f79d39391b46d6dbf1800fb68b8212a21d5ee2e/main/musl/APKBUILD)
includes the patch. Revalidate that evidence; no finding is suppressed or package
version relabeled. `VULNERABILITIES.md` preserves earlier findings and evidence.

## Safe reproduction and validation

Do not load `.env`, inspect `data/`, or contact the real SignalWire/Placetel
accounts for this review. The HTTP tests bind loopback and use dummy credentials.
The smoke fixture launches the actual server process with a local fake provider.

```sh
npm run check
npm test
git diff --check
docker buildx build --platform linux/amd64 --pull --load \
  --provenance=mode=max --sbom=true -t signalwire-placetel-tester:review .
docker run --rm --platform linux/amd64 --network none \
  --tmpfs /tmp:rw,nosuid,noexec,size=16m,mode=1777 \
  --mount "type=bind,source=$PWD/test,target=/app/test,readonly" \
  signalwire-placetel-tester:review node --test
docker run --rm --platform linux/amd64 --network none \
  --mount "type=bind,source=$PWD/test,target=/app/test,readonly" \
  --mount "type=bind,source=$PWD/scripts,target=/app/scripts,readonly" \
  signalwire-placetel-tester:review node scripts/check.mjs
docker run --rm --platform linux/amd64 --network none \
  --mount "type=bind,source=$PWD/scripts,target=/app/scripts,readonly" \
  signalwire-placetel-tester:review node scripts/smoke-container.mjs
docker scout cves --platform linux/amd64 schumann/signalwire-tester:v0.1.3
```

Expected validation: 38 tests including two HTTP deadline subtests; source/test/
script syntax checks; signed full round trip, failed wait, authentication,
correlation, deadline and provider failure regressions; smoke non-root execution,
package metadata, excluded tools/secrets, XML, and graceful shutdown. Automated
tests simulate the provider path. A live carrier round trip is a separate check
requiring publicly routed callbacks; it has not been rerun for this release.
