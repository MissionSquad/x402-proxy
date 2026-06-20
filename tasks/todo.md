# x402-proxy review & hardening

Baseline: 37 tests pass; coverage 70.2% lines / 57.3% branches. Target: >90% all metrics + `test:coverage` script (done).

Source of findings: multi-agent review (29 confirmed, 10 refuted). Refuted (do NOT "fix"): integer/hex/octal IP
literals (WHATWG URL normalizes → already blocked), settlement-header injection (closed key set in @x402/core),
error info-disclosure (context never serialized), Headers casing (case-insensitive), client-close stream abort
(atomic), ensureInitialized race (mislocated).

## Security
- [x] CRITICAL SSRF via redirect follow → `redirect: "manual"` on all fetches; relay 3xx + Location through
- [x] HIGH `isPrivateOrLoopbackIp` misses IPv4-mapped IPv6 (::ffff:* dotted+hex), ::, NAT64 64:ff9b::/96, fec0::/10
- [x] HIGH DNS-rebinding TOCTOU → strengthen validation + redirect:manual; document residual risk (no undici dep)
- [x] HIGH lease replay multi-instance → expose `leaseUseStore` in SDK config + wire + document shared-store req
- [~] MEDIUM lease token in ?t= query → document; keep x-x402-lease header path (already supported)
- [x] LOW lease secret entropy → document (length check kept)
- [~] LOW query param pollution → document; static handler honors excludeQueryParams

## Error handling
- [x] HIGH eventStore.record() unguarded → wrap every audit write in non-fatal try/catch helper
- [x] MEDIUM streaming backpressure → honor res.write() drain
- [x] MEDIUM request body size cap (maxRequestBodyBytes) → 413
- [x] MEDIUM client-disconnect vs timeout → don't write 504 to a closed socket; distinguish abort cause
- [x] MEDIUM WS relay send() throw → wrap in try/catch → closeBoth
- [x] LOW middleware unmapped errors (RouteBuildError/Validation/etc.) → clean JSON, no stack; double-send guards

## Compatibility (missionsquad-api + generic)
- [x] HIGH non-streaming responses forward NO headers → default safe response-header allowlist (content-type, etc.)
- [x] MEDIUM parsed non-JSON body re-encoded as JSON → serialize per content-type (urlencoded→querystring)
- [x] MEDIUM redirects followed → redirect:manual passthrough (same fix as SSRF)
- [x] LOW x-webhook-secret not forwarded → add to api-auth preset (missionsquad-api webhook routes)
- [x] LOW DELETE-with-body dropped → add DELETE to body methods
- [~] MEDIUM multipart → document (stream-through when no multipart parser mounted; size cap bounds memory)
- [~] LOW content-encoding handling → exclude content-encoding/content-length from response passthrough (fetch decompresses)

## Coverage (>90%)
- [x] tests/unit/httpProxy.test.ts (SSRF guard, body, timeouts, streaming, handler error branches, redirects)
- [x] tests/unit/discovery.test.ts, errors.test.ts, install.test.ts, resourceRuntime.test.ts
- [x] extend wsGateway/wsLease/streamLease/validation/resourceStore/routePattern/routeBuilder/currency tests
- [x] integration: response header passthrough, body round-trip, status codes, settlement-failure, lease rejects

## Review

**Outcome:** All confirmed findings addressed (fixed or documented). Build + typecheck clean; 183 tests pass.
Coverage: 95.7% stmts / 91.6% branches / 97.8% funcs / 96.0% lines (was 70/57/77/70). `test:coverage` added.

**Code changes**
- headerPolicy.ts: default safe response-header allowlist (fixes Content-Type drop); `x-webhook-secret` +
  common headers in api-auth; managed headers (content-encoding/length) never forwarded.
- httpProxy.ts: `redirect:"manual"` on all fetches (closes CRITICAL SSRF-via-redirect + relays 3xx);
  IPv4-mapped-IPv6/NAT64/`::`/site-local in SSRF guard + bracket/zone normalization; `maxRequestBodyBytes`
  cap (413); content-type-aware body re-encoding (urlencoded no longer corrupted); streaming backpressure;
  client-disconnect handled quietly; DELETE bodies forwarded.
- resourceRuntime.ts: `recordEvent` makes audit writes non-fatal; `sendProxyErrorResponse` (extracted, pure,
  exported) maps every error to a clean status+code, guards `headersSent`, no stack leak.
- wsGateway.ts: relay `send()` wrapped in try/catch → `closeBoth`.
- types.ts/install.ts: `leaseUseStore` + `maxRequestBodyBytes` config exposed and wired.
- install.ts: removed dead `installHttpEndpoints`/`installWebSocketLeaseEndpoints`/`registerMethodRoute`
  (superseded by the runtime middleware); `createHttpProxyHandler` kept + re-exported as a building block.

**Documented (not code-changed), with rationale in README:** DNS-rebinding residual TOCTOU (needs network
egress controls — not fixable in-process without a custom dispatcher/undici dep); multi-instance lease replay
(supply shared `leaseUseStore`); `?t=` query-token leakage (prefer `x-x402-lease`); `leaseTokenSecret` entropy;
verify→proxy→settle ordering for non-idempotent upstreams; multipart (don't mount a parser on proxied paths).

**Refuted by adversarial verification (intentionally NOT changed):** integer/hex/octal IP literals (WHATWG
`URL` already normalizes → blocked); settlement-header injection (`@x402/core` uses a closed key set); error
info-disclosure (error context is never serialized to clients); `Headers` casing (case-insensitive);
client-close stream abort (atomic); `ensureInitialized` race (mislocated).
