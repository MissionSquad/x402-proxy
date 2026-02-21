# x402-proxy

TypeScript SDK for building x402-protected HTTP and WebSocket proxy endpoints with EVM and SVM support.

## Install

```bash
npm install x402-proxy
```

## Usage

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
