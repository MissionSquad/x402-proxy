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

Payment headers, hop-by-hop headers, `host`, `content-length`, and lease tokens are never forwarded
upstream. Dynamic route params use `[name]` segments and upstream placeholders must come from the
matched public path.
