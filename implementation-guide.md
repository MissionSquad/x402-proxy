# x402 Proxy SDK Implementation Guide

## 1. Objective

Build a new npm SDK in `x402-proxy` that:

1. Protects **normal HTTP endpoints** with x402 payment verification/settlement.
2. Supports **WebSocket access** through paid lease/session issuance.
3. Supports both **EVM chains** (`eip155:*`) and **SVM chains** (`solana:*`).
4. Proxies paid requests to configured upstream targets.
5. Ships as a reusable TypeScript package with declaration files and strict typing.

This guide defines a standalone `x402-proxy` SDK.

## 2. Verified Contracts (Source of Truth)

All x402 API usage in this guide is based on official package contracts:

- `@x402/core/types`
- `@x402/core/server`
- `@x402/core/http`
- `@x402/express`
- `@x402/evm`
- `@x402/evm/exact/server`
- `@x402/svm`
- `@x402/svm/exact/server`

## 3. Protocol Baseline

1. x402 version baseline is **v2** (`@x402/core` exports `x402Version = 2`).
2. Request payment header expected by core server path: `PAYMENT-SIGNATURE`.
3. 402 response header for requirements: `PAYMENT-REQUIRED`.
4. Settlement response header: `PAYMENT-RESPONSE`.
5. Settlement behavior in `@x402/express`: settlement is skipped when downstream status is `>= 400`.
6. Network identifiers use CAIP-2 (`Network = \`${string}:${string}\``), including EVM `eip155:*` and SVM `solana:*`.

## 4. Required SDK Scope

### 4.1 HTTP proxy mode (mandatory)

- Paywalled HTTP route receives client request.
- If unpaid/invalid: return `402` + `PAYMENT-REQUIRED`.
- If paid and verified: forward to upstream HTTP target.
- If upstream status `< 400`: settle and add `PAYMENT-RESPONSE`.
- If upstream status `>= 400`: return upstream response, skip settlement.

### 4.2 WebSocket mode (mandatory)

- WebSocket access is paid via a **normal HTTP lease endpoint**.
- Lease endpoint is x402-protected and returns a short-lived lease token.
- Client connects to WS gateway using lease token.
- Gateway validates lease token and either accepts or rejects connection.

### 4.3 Multi-chain mode (mandatory)

- SDK must support endpoint-level `network` selection for `eip155:*` and `solana:*`.
- EVM examples include Ethereum mainnet (`eip155:1`) and Sepolia (`eip155:11155111`).
- SDK must register both server-side exact schemes:
  - `registerExactEvmScheme` for EVM networks.
  - `registerExactSvmScheme` for SVM networks.
- Each endpoint may override `network` and `payTo`; otherwise use SDK defaults.

## 5. Public SDK Contract

Use this as the initial public API. Keep it stable.

```ts
import type { Network } from '@x402/core/types';
import type { RouteConfig } from '@x402/core/server';
import type { Express, RequestHandler } from 'express';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export type CurrencyInput = {
  asset?: string;
  decimals?: number;
  symbol?: string;
};

export type HeaderPolicy = {
  forwardRequestHeaders?: string[];
  forwardResponseHeaders?: string[];
  addRequestHeaders?: Record<string, string>;
  addResponseHeaders?: Record<string, string>;
};

export type HttpProxyEndpointConfig = {
  kind: 'http';
  id: string;
  method: HttpMethod;
  publicPath: `/${string}`;
  upstreamUrl: string;
  network?: Network; // defaults to config.defaultNetwork
  payTo?: string; // defaults to config.defaultPayTo
  price: string;
  currency?: CurrencyInput;
  maxTimeoutSeconds?: number;
  description?: string;
  mimeType?: string;
  headers?: HeaderPolicy;
};

export type WebSocketProxyEndpointConfig = {
  kind: 'websocket';
  id: string;
  leaseMethod?: 'POST';
  leasePath: `/${string}`; // paid HTTP endpoint
  wsPath: `/${string}`; // websocket upgrade endpoint
  upstreamWsUrl: string;
  network?: Network; // defaults to config.defaultNetwork
  payTo?: string; // defaults to config.defaultPayTo
  price: string;
  currency?: CurrencyInput;
  leaseSeconds: number;
  maxTimeoutSeconds?: number;
  description?: string;
  mimeType?: string;
};

export type ProxyEndpointConfig = HttpProxyEndpointConfig | WebSocketProxyEndpointConfig;

export type FacilitatorConfig = {
  url?: string;
  authorizationBearer?: string;
};

export type DiscoveryConfig = {
  enabled: boolean;
  publicBaseUrl: string;
  ownershipProofs?: string[];
  instructions?: string;
};

export type SecurityConfig = {
  allowInsecureHttpUpstream?: boolean;
  allowPrivateIpUpstreams?: boolean;
  upstreamTimeoutMs?: number;
};

export type X402ProxySdkConfig = {
  defaultNetwork: Network;
  defaultPayTo: string;
  facilitator?: FacilitatorConfig;
  endpoints: ProxyEndpointConfig[];
  leaseTokenSecret: string;
  discovery?: DiscoveryConfig;
  security?: SecurityConfig;
  syncFacilitatorOnStart?: boolean;
};

export type X402ProxySdk = {
  routes: Record<string, RouteConfig>;
  paymentMiddleware: RequestHandler;
  install: (app: Express) => void;
};

export declare function createX402ProxySdk(config: X402ProxySdkConfig): X402ProxySdk;
```

## 6. Strict Type Rules for Endpoint Unions

`ProxyEndpointConfig` is a discriminated union. Access subtype fields only after narrowing:

```ts
function isHttpEndpoint(endpoint: ProxyEndpointConfig): endpoint is HttpProxyEndpointConfig {
  return endpoint.kind === 'http';
}

function isWebSocketEndpoint(endpoint: ProxyEndpointConfig): endpoint is WebSocketProxyEndpointConfig {
  return endpoint.kind === 'websocket';
}
```

Do not use `Partial<ProxyEndpointConfig>` for operational objects. Build concrete, complete subtype objects.

## 7. Project Structure

```text
x402-proxy/
  src/
    index.ts
    types.ts
    errors.ts
    validation.ts
    pricing.ts
    currency.ts
    routeBuilder.ts
    x402Server.ts
    payment.ts
    httpProxy.ts
    wsLease.ts
    wsGateway.ts
    discovery.ts
    install.ts
  tests/
    unit/
    integration/
  package.json
  tsconfig.json
  README.md
```

## 8. Implementation Details by Module

### 8.1 `src/types.ts`

- Export only public API contracts from Section 5.
- Keep runtime internals out of public types.
- JSDoc all exported types and required fields.

### 8.2 `src/errors.ts`

Define typed custom errors:

- `ConfigurationError`
- `ValidationError`
- `PriceConversionError`
- `RouteBuildError`
- `UpstreamRequestError`
- `UpstreamTimeoutError`
- `SecurityPolicyError`
- `LeaseTokenError`

All errors extend `Error` and include stable `code` and optional `context`.

### 8.3 `src/validation.ts`

Validate config before startup:

1. `leaseTokenSecret.length >= 32`.
2. `endpoints.length > 0`.
3. `defaultNetwork` matches CAIP-2 and starts with `eip155:` or `solana:`.
4. Per-endpoint `network` (if provided) matches the same rule.
5. `defaultPayTo` and endpoint `payTo` (if provided) are non-empty strings.
6. `publicPath`, `leasePath`, `wsPath` start with `/`.
7. `upstreamUrl` and `upstreamWsUrl` parse as URL.
8. `price` matches `/^\\d+(\\.\\d+)?$/` and `> 0`.
9. `leaseSeconds > 0` for `kind: 'websocket'`.
10. No duplicate `(method, publicPath)` for HTTP.
11. No duplicate `leasePath` or `wsPath` for WS.

### 8.4 `src/currency.ts`

Use chain-aware price resolution:

1. If endpoint currency is omitted, pass decimal `price` as `Money` and let the registered scheme resolve default asset/token.
2. If endpoint currency is provided, convert to base units and return explicit `AssetAmount`.
3. For SVM with currency but no asset, use `getUsdcAddress(network)`.
4. For EVM with currency but no asset, require explicit `currency.asset`.

```ts
import { getUsdcAddress } from '@x402/svm';
import type { Network, Price } from '@x402/core/types';
import { toBaseUnits } from './pricing';

type CurrencyInput = { asset?: string; decimals?: number; symbol?: string };

export function resolvePrice(network: Network, decimalPrice: string, currency?: CurrencyInput): Price {
  if (!currency) {
    return decimalPrice;
  }

  const decimals = currency.decimals ?? 6;
  const amount = toBaseUnits(decimalPrice, decimals);

  if (currency.asset) {
    return { asset: currency.asset, amount };
  }

  if (network.startsWith('solana:')) {
    return { asset: getUsdcAddress(network), amount };
  }

  throw new Error('currency.asset is required for eip155 networks when currency override is provided');
}
```

### 8.5 `src/pricing.ts`

Use deterministic ceiling conversion to base units:

```ts
import BigNumber from 'bignumber.js';

export function toBaseUnits(decimalAmount: string, decimals: number): string {
  const amount = new BigNumber(decimalAmount);
  if (!amount.isFinite() || amount.lte(0)) {
    throw new Error(`Invalid amount: ${decimalAmount}`);
  }
  const scaled = amount.times(new BigNumber(10).pow(decimals));
  return scaled.integerValue(BigNumber.ROUND_CEIL).toFixed(0);
}
```

### 8.6 `src/routeBuilder.ts`

Build x402 routes from endpoint config.

Route key format:

- HTTP: `${method} ${publicPath}`
- WS lease endpoint: `POST ${leasePath}`

Create one `RouteConfig` per protected endpoint:

```ts
import type { RouteConfig } from '@x402/core/server';
import type { Network, Price } from '@x402/core/types';

type BuildInput = {
  network: Network;
  payTo: string;
  publicResourceUrl?: (path: string) => string | undefined;
};

export function buildRouteConfig(
  path: string,
  price: Price,
  input: BuildInput,
  description: string,
  mimeType = 'application/json',
  maxTimeoutSeconds = 60,
): RouteConfig {
  return {
    accepts: {
      scheme: 'exact',
      network: input.network,
      payTo: input.payTo,
      price,
      maxTimeoutSeconds,
      extra: {},
    },
    resource: input.publicResourceUrl?.(path),
    description,
    mimeType,
  };
}
```

### 8.7 `src/x402Server.ts`

Wire x402 server with verified signatures:

```ts
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server';
import { registerExactEvmScheme } from '@x402/evm/exact/server';
import { registerExactSvmScheme } from '@x402/svm/exact/server';

export function createResourceServer(facilitatorUrl?: string, bearer?: string) {
  const client = new HTTPFacilitatorClient({
    url: facilitatorUrl,
    createAuthHeaders: bearer
      ? async () => ({
          verify: { Authorization: `Bearer ${bearer}` },
          settle: { Authorization: `Bearer ${bearer}` },
          supported: { Authorization: `Bearer ${bearer}` },
        })
      : undefined,
  });

  const server = new x402ResourceServer(client);
  registerExactEvmScheme(server); // eip155:* (default)
  registerExactSvmScheme(server);
  return server;
}
```

### 8.8 `src/payment.ts`

Create Express middleware from verified `@x402/express` API:

```ts
import { paymentMiddleware } from '@x402/express';
import type { RoutesConfig, x402ResourceServer } from '@x402/core/server';

export function createPaymentMiddleware(
  routes: RoutesConfig,
  server: x402ResourceServer,
  syncFacilitatorOnStart: boolean,
) {
  return paymentMiddleware(routes, server, undefined, undefined, syncFacilitatorOnStart);
}
```

### 8.9 `src/httpProxy.ts`

Mandatory behavior:

1. Only proxy requests that already passed payment middleware.
2. Copy method and query string.
3. Preserve body for `POST|PUT|PATCH`.
4. Forward request headers by allowlist only.
5. Drop hop-by-hop headers:
   - `connection`
   - `keep-alive`
   - `proxy-authenticate`
   - `proxy-authorization`
   - `te`
   - `trailer`
   - `transfer-encoding`
   - `upgrade`
6. Never forward payment headers upstream:
   - `payment-signature`
   - `payment-required`
   - `payment-response`
   - `x-payment`
   - `x-payment-response`
7. Use `AbortController` timeout.

Security requirements:

1. Reject insecure `http:` upstream unless explicitly enabled.
2. Reject private or loopback upstream IPs unless explicitly enabled.
3. Resolve DNS and re-check IP family/range before connect.

### 8.10 `src/wsLease.ts`

Implement lease issuance over HTTP:

1. Endpoint is normal x402-protected HTTP route (`POST /.../lease`).
2. On paid request, create lease token containing:
   - `endpointId`
   - `exp` (unix seconds)
   - `jti` (random unique id)
   - `upstreamWsUrl`
3. Sign token with HMAC-SHA256 using `leaseTokenSecret`.
4. Return:
   - `token`
   - `wsUrl` (public ws path + query token)
   - `expiresAt`
   - `leaseSeconds`

Recommended response:

```json
{
  "token": "<opaque-token>",
  "wsUrl": "wss://api.example.com/ws/market?t=<token>",
  "expiresAt": "2026-02-21T12:34:56.000Z",
  "leaseSeconds": 60
}
```

### 8.11 `src/wsGateway.ts`

Do not assume a specific WS library in core SDK. Define an adapter interface:

```ts
export interface WebSocketConnection {
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  onMessage(handler: (data: string | Buffer) => void): void;
  onClose(handler: () => void): void;
  onError(handler: (error: Error) => void): void;
}

export interface WebSocketServerAdapter {
  onConnection(path: string, handler: (query: URLSearchParams, conn: WebSocketConnection) => void): void;
}
```

Gateway flow:

1. Parse `t` token from query params.
2. Verify signature and expiry.
3. Enforce one-time or limited-use policy per `jti`.
4. Open upstream WS connection.
5. Bi-directionally relay frames.
6. Close both sides on any terminal error.

## 9. HTTP and WS Endpoint Coverage Model

Treat both endpoint classes as first-class:

1. HTTP endpoint: paywalled data/API request and response proxy.
2. WS endpoint: paywalled lease issuance over HTTP, then tokenized WS session.
3. Chain selection: each endpoint can run on EVM or SVM via `network`.

Example config:

```ts
const config = {
  defaultNetwork: 'eip155:8453',
  defaultPayTo: '<recipient-address>',
  leaseTokenSecret: process.env.LEASE_SECRET!,
  endpoints: [
    {
      kind: 'http',
      id: 'prices-http',
      method: 'GET',
      publicPath: '/api/prices',
      upstreamUrl: 'https://upstream.internal/prices',
      network: 'eip155:8453',
      price: '0.01',
    },
    {
      kind: 'websocket',
      id: 'trades-ws',
      leasePath: '/api/ws/trades/lease',
      wsPath: '/ws/trades',
      upstreamWsUrl: 'wss://upstream.internal/ws/trades',
      network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      price: '0.03',
      leaseSeconds: 60,
    },
  ],
};
```

## 10. Discovery Endpoints

Implement:

- `GET /.well-known/x402`
- `GET /x402-discovery.json`

Schema:

```ts
{
  version: 1;
  resources: string[]; // all paid HTTP paths + WS lease HTTP paths as full URLs
  ownershipProofs?: string[];
  instructions?: string;
}
```

For WS, include **lease endpoint URLs** in discovery resources (not raw WS URLs), because discovery enumerates x402-enabled resources.

## 11. `tsconfig.json` (required)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "src",
    "outDir": "dist",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "useUnknownInCatchVariables": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

## 12. `package.json` requirements

Mandatory fields:

- `name`, `version`, `description`
- `main`, `module`, `types`
- `exports` with `import`, `require`, `types`
- `files: ["dist", "README.md", "LICENSE"]`
- `engines.node: ">=20"`

Runtime dependencies must include:

- `@x402/core`
- `@x402/express`
- `@x402/evm`
- `@x402/svm`

Mandatory scripts:

- `build`: compile TS to `dist`
- `test`: unit + integration
- `typecheck`: strict compile without emit
- `prepublishOnly`: `npm run typecheck && npm run test && npm run build`

## 13. Testing Strategy

### 13.1 Unit tests

- Config validation for both endpoint kinds.
- Price to base-unit conversion with rounding.
- Route generation for HTTP and WS lease routes.
- Header filtering and hop-by-hop stripping.
- Lease token sign/verify and expiry behavior.
- Union narrowing guards.

### 13.2 Integration tests

Run with:

- Mock facilitator (`/supported`, `/verify`, `/settle`).
- Mock upstream HTTP server.
- Mock WS upstream server.

Cases:

1. HTTP unpaid request returns `402` + `PAYMENT-REQUIRED`.
2. HTTP paid EVM request returns upstream body and `PAYMENT-RESPONSE`.
3. HTTP paid SVM request returns upstream body and `PAYMENT-RESPONSE`.
4. HTTP paid request with upstream `500` returns `500` and no settlement.
5. WS lease unpaid request returns `402`.
6. WS lease paid request returns token and wsUrl.
7. WS connect with valid token succeeds and relays frames.
8. WS connect with expired/invalid token fails with close code.

### 13.3 Regression tests

- Each endpoint config maps to exactly one x402-protected route.
- HTTP routes stay independent from WS route maps.
- EVM and SVM endpoint routes resolve to correct network/payTo values.
- Discovery resources include all paid HTTP + WS lease URLs.

## 14. CI Gate

Minimum pipeline:

1. `npm ci`
2. `npm run typecheck`
3. `npm run test`
4. `npm run build`
5. `npm pack --dry-run` and assert declaration files are included.

Fail release on any step failure.

## 15. Consumer Integration Example

```ts
import express from 'express';
import { createX402ProxySdk } from '@your-scope/x402-proxy';

const app = express();
app.use(express.json({ limit: '1mb' }));

const sdk = createX402ProxySdk({
  defaultNetwork: 'eip155:8453',
  defaultPayTo: process.env.X402_PAY_TO!,
  leaseTokenSecret: process.env.LEASE_SECRET!,
  facilitator: {
    url: 'https://x402.org/facilitator',
    authorizationBearer: process.env.FACILITATOR_TOKEN,
  },
  endpoints: [
    {
      kind: 'http',
      id: 'quotes',
      method: 'GET',
      publicPath: '/api/quotes',
      upstreamUrl: 'https://internal.example.com/quotes',
      network: 'eip155:8453',
      price: '0.01',
    },
    {
      kind: 'websocket',
      id: 'trades',
      leasePath: '/api/ws/trades/lease',
      wsPath: '/ws/trades',
      upstreamWsUrl: 'wss://internal.example.com/ws/trades',
      network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      price: '0.02',
      leaseSeconds: 60,
    },
  ],
  discovery: {
    enabled: true,
    publicBaseUrl: 'https://api.example.com',
  },
});

sdk.install(app);
app.listen(4021);
```

## 16. Implementation Sequence (Checklist)

1. Initialize package scaffold (`src`, `tests`, strict TS config).
2. Implement public types and custom errors.
3. Implement config validation with endpoint-level network/payTo overrides.
4. Implement chain-aware currency/price resolution (EVM + SVM).
5. Implement route builder for HTTP and WS lease endpoints.
6. Implement x402 resource server bootstrap and register exact EVM + SVM schemes.
7. Implement HTTP proxy handler with timeout, header policy, and SSRF guards.
8. Implement lease token signer/verifier and lease issuance endpoint.
9. Implement WebSocket gateway adapter and upstream relay logic.
10. Implement discovery document endpoints.
11. Add unit tests for all pure modules.
12. Add integration tests with mock facilitator + upstreams for both chain families.
13. Run `typecheck`, `test`, `build`, and `npm pack --dry-run`.
14. Publish only when all checks pass.

## 17. Completion Audit for This Guide

1. Standalone SDK scope is defined for `x402-proxy` only.
2. Normal HTTP endpoints are fully covered as first-class functionality.
3. EVM and SVM support are both defined using official exact-scheme registrations.
4. WebSocket support is covered through paid lease + tokenized gateway flow.
5. x402 API references are aligned to official `@x402/*` type contracts and middleware behavior.
