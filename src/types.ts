import type { PaywallConfig, PaywallProvider, RouteConfig } from "@x402/core/server";
import type { Network } from "@x402/core/types";
import type { Express, RequestHandler } from "express";

import type { X402LeaseUseStore } from "./streamLease";

/**
 * Supported HTTP methods for proxied endpoints.
 */
export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS";

/**
 * Optional currency override for endpoint pricing.
 */
export type CurrencyInput = {
  asset?: string;
  decimals?: number;
  symbol?: string;
};

/**
 * Request/response header forwarding and static header injection policy.
 */
export type HeaderPolicy = {
  presets?: X402HeaderPreset[];
  forwardRequestHeaders?: string[];
  forwardResponseHeaders?: string[];
  addRequestHeaders?: Record<string, string>;
  addResponseHeaders?: Record<string, string>;
};

export type X402ResourceKind = "http" | "http-stream" | "websocket";

export type X402AccessMode = "pass-through" | "service-token";

export type X402HeaderPreset = "none" | "api-auth" | "browser-auth" | "streaming";

export type X402HeaderPolicy = {
  presets?: X402HeaderPreset[];
  forwardRequestHeaders?: string[];
  forwardResponseHeaders?: string[];
  addRequestHeaders?: Record<string, string>;
  addResponseHeaders?: Record<string, string>;
};

export type X402Resource = {
  id: string;
  enabled: boolean;
  kind: X402ResourceKind;
  publicPath: string;
  upstreamUrl: string;
  method: HttpMethod;
  pricing: {
    amount: string;
    network: Network;
    payTo: string;
    asset?: string;
    decimals?: number;
  };
  headers?: X402HeaderPolicy;
  access?: {
    mode: X402AccessMode;
    serviceTokenHeader?: string;
    serviceTokenValue?: string;
  };
  stream?: {
    leasePath: string;
    leaseSeconds: number;
    allowRenewal: boolean;
    renewalWindowSeconds: number;
  };
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
};

export type X402AccessEvent = {
  id: string;
  resourceId: string;
  kind: "challenge" | "verified" | "settled" | "settlement_failed" | "lease_issued" | "lease_rejected";
  requestMethod: string;
  requestPath: string;
  network?: Network;
  payTo?: string;
  amount?: string;
  payer?: string;
  transaction?: string;
  statusCode?: number;
  errorCode?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
};

export interface X402ResourceStore {
  listEnabledResources(): Promise<X402Resource[]>;
  getResourceById(id: string): Promise<X402Resource | null>;
  getResourceForRequest(method: string, path: string): Promise<X402Resource | null>;
}

export interface X402AccessEventStore {
  record(event: X402AccessEvent): Promise<void>;
}

/**
 * Configuration for a paid HTTP endpoint that proxies to an upstream HTTP URL.
 */
export type HttpProxyEndpointConfig = {
  kind: "http";
  id: string;
  method: HttpMethod;
  publicPath: `/${string}`;
  upstreamUrl: string;
  network?: Network;
  payTo?: string;
  price: string;
  currency?: CurrencyInput;
  maxTimeoutSeconds?: number;
  description?: string;
  mimeType?: string;
  headers?: HeaderPolicy;
};

/**
 * Configuration for a paid WebSocket endpoint backed by a paid HTTP lease route.
 */
export type WebSocketProxyEndpointConfig = {
  kind: "websocket";
  id: string;
  leaseMethod?: "POST";
  leasePath: `/${string}`;
  wsPath: `/${string}`;
  upstreamWsUrl: string;
  network?: Network;
  payTo?: string;
  price: string;
  currency?: CurrencyInput;
  leaseSeconds: number;
  maxTimeoutSeconds?: number;
  description?: string;
  mimeType?: string;
};

/**
 * Supported endpoint configuration union.
 */
export type ProxyEndpointConfig = HttpProxyEndpointConfig | WebSocketProxyEndpointConfig;

/**
 * Optional facilitator HTTP client settings.
 */
export type FacilitatorConfig = {
  url?: string;
  authorizationBearer?: string;
};

/**
 * Discovery document configuration.
 */
export type DiscoveryConfig = {
  enabled: boolean;
  publicBaseUrl: string;
  ownershipProofs?: string[];
  instructions?: string;
};

/**
 * Upstream request security policy.
 */
export type SecurityConfig = {
  allowInsecureHttpUpstream?: boolean;
  allowPrivateIpUpstreams?: boolean;
  upstreamTimeoutMs?: number;
  /**
   * Maximum buffered request body size in bytes for proxied requests whose body the
   * proxy reads from the raw stream (i.e. no upstream body parser ran). Defaults to
   * unlimited to avoid breaking large/streamed uploads; set a value to bound memory
   * use. Requests exceeding the limit are rejected with HTTP 413.
   */
  maxRequestBodyBytes?: number;
};

/**
 * Root SDK configuration.
 */
export type X402ProxySdkConfig = {
  defaultNetwork: Network;
  defaultPayTo: string;
  facilitator?: FacilitatorConfig;
  endpoints?: ProxyEndpointConfig[];
  resourceStore?: X402ResourceStore;
  accessEventStore?: X402AccessEventStore;
  /**
   * Single-use lease consumption store for HTTP-stream lease tokens. Defaults to an
   * in-process store, which only prevents replay within a single instance. Multi-instance
   * or horizontally-scaled deployments MUST supply a shared store (e.g. Redis with atomic
   * SET NX + TTL) to enforce single-use across the cluster.
   */
  leaseUseStore?: X402LeaseUseStore;
  requireProtectedResources?: boolean;
  leaseTokenSecret: string;
  discovery?: DiscoveryConfig;
  security?: SecurityConfig;
  syncFacilitatorOnStart?: boolean;
  /**
   * Optional paywall provider that renders the full wallet-connect payment UI for
   * browser requests hitting protected endpoints (e.g. from @x402/paywall:
   * `createPaywall().withNetwork(evmPaywall).build()`). Without it, browsers get
   * the basic built-in "Payment Required" page.
   */
  paywall?: PaywallProvider;
  /**
   * Customization for the browser paywall (app name/logo, testnet chain selection).
   * When `testnet` is not set it is derived from `defaultNetwork` (known testnets
   * only) instead of inheriting @x402/core's default of `true`, which would point
   * mainnet deployments at testnet chains.
   */
  paywallConfig?: PaywallConfig;
};

/**
 * Public SDK instance contract.
 */
export type X402ProxySdk = {
  routes: Record<string, RouteConfig>;
  paymentMiddleware: RequestHandler;
  refreshResources: () => Promise<X402ResourceRefreshResult>;
  listLoadedResources: () => X402LoadedResource[];
  diagnostics: () => X402ProxyDiagnostics;
  install: (app: Express) => void;
};

export type X402LoadedResource = {
  id: string;
  kind: X402ResourceKind;
  method: HttpMethod;
  publicPath: string;
  paymentPath: string;
  upstreamUrl: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
};

export type X402ResourceValidationIssue = {
  resourceId: string;
  reason: string;
};

export type X402ResourceRefreshResult = {
  loaded: X402LoadedResource[];
  invalid: X402ResourceValidationIssue[];
  refreshedAt: number;
};

export type X402ProxyDiagnostics = {
  loadedResourceCount: number;
  invalidResourceCount: number;
  invalidResources: X402ResourceValidationIssue[];
  lastRefreshAt?: number;
  facilitatorUrl?: string;
  enabledNetworks: Network[];
  storeType: string;
};

/**
 * Runtime-checked type guard for HTTP endpoint configs.
 */
export function isHttpEndpoint(endpoint: ProxyEndpointConfig): endpoint is HttpProxyEndpointConfig {
  return endpoint.kind === "http";
}

/**
 * Runtime-checked type guard for WebSocket endpoint configs.
 */
export function isWebSocketEndpoint(
  endpoint: ProxyEndpointConfig,
): endpoint is WebSocketProxyEndpointConfig {
  return endpoint.kind === "websocket";
}
