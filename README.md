# x402-proxy

TypeScript SDK for building x402-protected HTTP and WebSocket proxy endpoints with EVM and SVM support.

## Install

```bash
npm install x402-proxy
```

## Usage

### Static HTTP Resource

```ts
import express from "express";
import { createX402ProxySdk } from "x402-proxy";

const app = express();

const sdk = createX402ProxySdk({
  defaultNetwork: "eip155:8453",
  defaultPayTo: "0xPayee",
  leaseTokenSecret: "lease-token-secret-with-32-characters",
  endpoints: [
    {
      kind: "http",
      id: "quotes",
      method: "GET",
      publicPath: "/api/quotes",
      upstreamUrl: "https://internal.example.com/quotes",
      price: "0.01",
    },
  ],
});

sdk.install(app);
app.listen(4021);
```

### Dynamic HTTP Resources

```ts
import express from "express";
import {
  createX402ProxySdk,
  InMemoryX402ResourceStore,
  type X402Resource,
} from "x402-proxy";

const resources: X402Resource[] = [
  {
    id: "agent-summary",
    enabled: true,
    kind: "http",
    method: "POST",
    publicPath: "/paid/agents/[username]/[slug]/summary",
    upstreamUrl: "https://internal.example.com/v1/agents/[username]/[slug]/summary",
    pricing: { amount: "0.01", network: "eip155:8453", payTo: "0xPayee" },
    headers: { presets: ["api-auth"] },
    access: { mode: "pass-through" },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
];

const app = express();
const sdk = createX402ProxySdk({
  defaultNetwork: "eip155:8453",
  defaultPayTo: "0xPayee",
  leaseTokenSecret: "lease-token-secret-with-32-characters",
  resourceStore: new InMemoryX402ResourceStore(resources),
  security: {
    allowInsecureHttpUpstream: false,
    allowPrivateIpUpstreams: false,
  },
});

await sdk.refreshResources();
sdk.install(app);
app.listen(4021);
```

### HTTP Streaming Lease Resource

```ts
const streamResource: X402Resource = {
  id: "agent-chat-stream",
  enabled: true,
  kind: "http-stream",
  method: "POST",
  publicPath: "/paid/agents/[username]/[slug]/chat",
  upstreamUrl: "https://internal.example.com/v1/agents/[username]/[slug]/chat",
  pricing: { amount: "0.02", network: "eip155:8453", payTo: "0xPayee" },
  headers: { presets: ["api-auth", "streaming"] },
  access: { mode: "pass-through" },
  stream: {
    leasePath: "/paid/agents/[username]/[slug]/chat/lease",
    leaseSeconds: 600,
    allowRenewal: false,
    renewalWindowSeconds: 120,
  },
  createdAt: Date.now(),
  updatedAt: Date.now(),
};
```

Clients pay `POST /paid/agents/alice/research/chat/lease`, receive a signed lease, then call
`POST /paid/agents/alice/research/chat?t=<lease>`. The stream path validates the lease and proxies
upstream chunks directly; the x402 settlement wrapper is not placed around the streaming response.

### Direct (single-request) Streaming Resource

`http-stream-direct` takes payment on the request itself — the standard x402 402-retry
flow, no lease endpoint — then pipes the upstream response unbuffered. Both SSE and
buffered JSON upstream responses relay through the same pipe, so one resource serves
OpenAI-style `stream: true` and `stream: false` bodies alike. Settlement happens after
the upstream **accepts** the request (status < 400) and before any body bytes relay:
upstream outages and upstream error responses are never charged; failures after
settlement (mid-stream) are not refunded.

```ts
const directStream: X402Resource = {
  id: "agent-a-chat",
  enabled: true,
  kind: "http-stream-direct",
  method: "POST",
  publicPath: "/v1/chat/completions",
  match: { bodyField: "model", equals: "alice/agent-a" },
  upstreamUrl: "https://internal.example.com/v1/chat/completions",
  pricing: { amount: "0.02", network: "eip155:8453", payTo: "0xAlice" },
  headers: { presets: ["streaming"], addRequestHeaders: { "content-type": "application/json" } },
  access: { mode: "service-token", serviceTokenHeader: "x-api-key", serviceTokenValue: "..." },
  createdAt: Date.now(),
  updatedAt: Date.now(),
};
```

### Body-matched resources (shared publicPath)

The optional `match: { bodyField, equals }` discriminator lets many resources share one
`publicPath`, selected by a field of the parsed JSON request body — e.g. an
OpenAI-compatible endpoint where the `model` string picks the paid resource and
therefore the price/payTo/network. Rules:

- Allowed on `http` and `http-stream-direct` kinds (payment happens on the public
  request, where the body is present).
- Requires a JSON body parser (`express.json()`) mounted **before** the proxy
  middleware; without a parsed body the resource never matches.
- Body-matched resources take precedence over unmatched resources on the same path; a
  request whose body matches no discriminator falls through to the host app (`next()`),
  so unknown values keep their existing behavior (e.g. a 401/404 from your own routes).
- Two resources may not claim the same `(method, publicPath, bodyField, equals)`.
- The 402 challenge advertises the real request URL; the synthetic per-resource route
  key used internally never appears on the wire.

When the shared path also serves first-party authenticated traffic, compose the
middleware yourself so credentialed requests never see a 402, and mount the
diagnostics/discovery routes separately (do not also call `install`, which would mount
a second, unwrapped copy):

```ts
app.use((req, res, next) => (hasFirstPartyCredentials(req) ? next() : sdk.middleware(req, res, next)));
sdk.installManagementRoutes(app);
```

### WebSocket Lease Resource

```ts
import {
  installWebSocketGateway,
  webSocketGatewayEndpointsFromResources,
} from "x402-proxy";

const wsResource: X402Resource = {
  id: "prices-ws",
  enabled: true,
  kind: "websocket",
  method: "GET",
  publicPath: "/ws/prices",
  upstreamUrl: "wss://internal.example.com/ws/prices",
  pricing: { amount: "0.05", network: "eip155:8453", payTo: "0xPayee" },
  access: { mode: "pass-through" },
  stream: {
    leasePath: "/paid/ws/prices/lease",
    leaseSeconds: 300,
    allowRenewal: false,
    renewalWindowSeconds: 60,
  },
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

installWebSocketGateway(adapter, connector, {
  leaseTokenSecret: "lease-token-secret-with-32-characters",
  endpoints: webSocketGatewayEndpointsFromResources([wsResource]),
});
```

Client-supplied payment headers (including all `x-x402-*` names), hop-by-hop headers, `host`,
`content-length`, and lease tokens are never forwarded upstream. The proxy itself injects trusted
`x-x402-*` payment-metadata headers on paid upstream requests (see
[Payment metadata forwarding](#payment-metadata-forwarding)). Dynamic route params use `[name]`
segments and upstream placeholders must come from the matched public path.

## Header forwarding

Request headers are forwarded only when allow-listed. Use a preset and/or `forwardRequestHeaders`:

- `api-auth` forwards `authorization`, `x-api-key`, `content-type`, `accept`, `user-agent`,
  `x-client-id`, `x-session-id`.
- `browser-auth` forwards `cookie`, `authorization`, `content-type`, `accept`, `user-agent`,
  `x-client-id`, `x-session-id`.
- `streaming` (response side) forwards `content-type`, `cache-control`, `connection`,
  `x-accel-buffering`, `x-run-id` (note `connection` is hop-by-hop and is always stripped in
  practice; it is listed for spec parity only).

For any other upstream-required header (custom signatures, `x-request-id`, `idempotency-key`,
webhook secrets, etc.) add it to `headers.forwardRequestHeaders`. To remove a preset-granted header,
list it in `headers.excludeRequestHeaders` / `headers.excludeResponseHeaders` (e.g. keep
`browser-auth` but drop `cookie`). Excludes apply only to headers copied from the inbound
request/upstream response; explicit `addRequestHeaders`/`addResponseHeaders` values are unaffected.

### Upstream access modes

HTTP resources (`kind: "http"` and `kind: "http-stream"`) may set `access.mode`:

- `pass-through` (default): client credentials reach the upstream only per the header policy above.
- `service-token`: the proxy injects `access.serviceTokenHeader: access.serviceTokenValue` on the
  upstream request, replacing any client-supplied value for that header. Use this when the upstream
  requires a private service credential the paying client does not have:

```ts
{
  // ...resource fields...
  headers: { presets: ["api-auth"] },
  access: {
    mode: "service-token",
    serviceTokenHeader: "Authorization",
    serviceTokenValue: `Bearer ${process.env.UPSTREAM_SERVICE_TOKEN}`,
  },
}
```

`serviceTokenHeader` must be a valid HTTP header name (RFC 9110 token — no whitespace) and must
not be a payment, hop-by-hop, `host`, or `content-length` header; `serviceTokenValue` must not
contain control characters (validation rejects all of these, and injection independently refuses
them as defense in depth). The token value is never logged and never appears in diagnostics or
discovery output. WebSocket resources are relayed without header forwarding or injection, so
`service-token` does not apply to them and validation rejects the combination.

Responses always forward a safe default set (`content-type`, `content-disposition`,
`content-language`, `content-range`, `accept-ranges`, `cache-control`, `etag`, `last-modified`,
`expires`, `vary`, `location`, `retry-after`, `www-authenticate`) plus anything in
`headers.forwardResponseHeaders`. `content-encoding` and `content-length` are never forwarded because
the proxy re-frames the body (`fetch` transparently decompresses upstream responses). Upstream `3xx`
responses are relayed verbatim (`Location` included) rather than followed.

## Payment metadata forwarding

For every paid upstream request the proxy injects trusted `x-x402-*` headers describing the verified
payment, so upstreams (e.g. a host API mounting this SDK in-process) can do payer/transaction-level
accounting. Values come from the verified accepted payment requirements and the settle result — never
from client-controlled payload fields.

| Header | Value |
| --- | --- |
| `x-x402-payment-id` | SDK-generated UUID for this verified payment; correlates with `onPaymentSettled` |
| `x-x402-resource-id` | Resource id, **always `encodeURIComponent`-encoded** (ids may contain `/`, spaces, `%`, ...) — decode before comparing |
| `x-x402-scheme` | Accepted payment scheme (e.g. `exact`) |
| `x-x402-network` | Accepted CAIP-2 network |
| `x-x402-amount` | Accepted on-chain amount (base units) |
| `x-x402-asset` | Accepted asset address |
| `x-x402-pay-to` | Accepted payout address |
| `x-x402-payer` | Settled payer address (settle result) — only when settlement precedes the upstream request |
| `x-x402-transaction` | Settlement transaction hash — only when settlement precedes the upstream request |

Per-kind availability:

| Kind | Headers on the upstream request |
| --- | --- |
| `http` | All except `x-x402-payer`/`x-x402-transaction` (settles after the upstream accepts) — correlate via `x-x402-payment-id` + `onPaymentSettled` |
| `http-stream-direct` | Same as `http` |
| `http-stream` (lease relay) | Full set including `x-x402-payer` and `x-x402-transaction` (settlement happened at lease issuance; the details ride inside the signed lease token, so leases minted before 0.2.1 relay without metadata headers) |

To be notified of every successful settlement — including `http`/`http-stream-direct`, whose
`payer`/`transaction` are only known post-request — supply `onPaymentSettled`:

```ts
const sdk = createX402ProxySdk({
  // ...
  onPaymentSettled: async (event) => {
    // event: { paymentId, resourceId, kind, transaction, network, payer?, requirements, settledAt }
    await accounting.recordSettlement(event.paymentId, event.payer, event.transaction, event.requirements);
  },
});
```

The callback fires for all resource kinds and is fire-and-forget: a throwing or rejecting callback
never affects the payment or the proxied response. Set `forwardPaymentMetadata: false` to disable the
upstream headers; the `onPaymentSettled` callback fires regardless.

**Security.** The nine `x-x402-*` metadata names are internal payment headers: client-supplied values
for them are always stripped and can never reach the upstream — not even when a resource's
`forwardRequestHeaders` explicitly lists them — so any `x-x402-*` value an upstream sees was injected
by the proxy. Metadata values are additionally guarded (printable ASCII only, resource ids
URI-encoded); an invalid value is skipped rather than breaking the paid request.

## Request bodies

The proxy forwards `POST`, `PUT`, `PATCH`, and `DELETE` bodies. When no body parser has consumed the
request stream, the raw bytes are forwarded verbatim (so `multipart/form-data` works as long as the
host app does **not** mount a multipart parser on a proxied path). When a parser has already run,
`application/x-www-form-urlencoded` bodies are re-encoded as form data and everything else as JSON.
Set `security.maxRequestBodyBytes` to bound buffered body size (requests over the limit return `413`);
it defaults to unlimited so large/streamed uploads are not broken by default.

## Security and operational notes

- **Upstream SSRF protection.** By default (`security.allowPrivateIpUpstreams: false`) upstream hosts
  resolving to private, loopback, link-local, unique-local, CGNAT, multicast, IPv4-mapped-IPv6
  (`::ffff:*`), or NAT64 (`64:ff9b::/96`) addresses are rejected, and `http:` upstreams require
  `security.allowInsecureHttpUpstream: true`. Redirects are not followed. **Residual risk:** the
  guard validates DNS before `fetch` re-resolves, so an attacker controlling an upstream hostname's
  DNS can still mount a DNS-rebinding (TOCTOU) attack. For untrusted/dynamic upstreams, also enforce
  egress controls at the network layer.
- **Lease replay across instances.** The default lease single-use store and the WebSocket gateway's
  consumed-token map are in-process only. In multi-instance/horizontally-scaled deployments supply a
  shared `leaseUseStore` (e.g. Redis with atomic `SET NX` + TTL) and keep `leaseSeconds` small.
- **Lease token transport.** Prefer the `x-x402-lease` request header over the `?t=` query parameter
  (query strings leak via access logs, `Referer`, and browser history). Set `Referrer-Policy:
  no-referrer` and scrub `t` from logs if the query form is unavoidable.
- **`leaseTokenSecret`** must be a high-entropy random value (≥ 32 random bytes, e.g. from
  `crypto.randomBytes`), kept out of source control and rotated periodically. The 32-character length
  check is a floor, not a guarantee of entropy.
- **Audit events are best-effort.** A failing `accessEventStore.record` never changes the user-facing
  result of a paid request.
- **Settlement ordering.** `http` requests are settled after a successful (`< 400`) upstream response
  (verify → proxy → settle). For non-idempotent upstreams a settlement failure after the upstream
  side effect leaves the user un-charged for an action already performed; supply an `accessEventStore`
  to capture `settlement_failed` events for reconciliation. `http-stream-direct` requests settle
  after the upstream response headers arrive with status < 400 and before any body bytes are
  relayed (verify → connect → settle → pipe): upstream outages/errors are never charged, the
  `PAYMENT-RESPONSE` header always precedes the stream, and a mid-stream failure after settlement
  is not refunded. If settlement itself fails after connect, the upstream request is aborted.
- **Facilitator sync failures are isolated and retryable.** A resource whose
  `(network, scheme)` the facilitator does not support is pruned to the invalid list on
  the first payment request (visible in `/x402/diagnostics`) instead of failing the
  whole paid surface. Any other sync failure (e.g. facilitator unreachable) fails
  payment requests with `503 FACILITATOR_SYNC_ERROR`, surfaces as
  `diagnostics().facilitatorSyncError`, and is retried on the next payment request. A
  failed background sync never raises an unhandled promise rejection.
- **Refresh races answer 503.** A request that matches a resource whose payment route is
  missing from the just-swapped route generation receives `503 RESOURCE_ROUTE_SYNC_ERROR`
  (retryable) instead of hanging.
