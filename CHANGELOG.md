# Changelog

Versions below 1.0 remain unstable. Security and compatibility fixes use patch
releases; behavior may change in minor releases.

## 0.1.2 — 2026-11-02

- Pin Node 22.23.4 and Alpine 3.24 by digest, addressing the 27 Node CVEs
  reported for the previously published Node 22.22.3 image, including the
  October security release fixes.
- Preserve package metadata for copied runtime libraries so scanners can
  identify their versions in the scratch image.
- Require full phone-number matches in the destination allowlist and callback
  correlation; continue accepting German national and E.164 formats. Reject
  SIP URIs and dial-control strings when a destination allowlist is configured.
- Reject SignalWire callbacks when verification is forced on but its signing
  secret or public URL is missing.
- Add static checks, security regression tests, and an isolated container
  integration check covering signed callbacks, pass/fail behavior, and shutdown.
