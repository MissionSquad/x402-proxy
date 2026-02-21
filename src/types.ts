import type { RouteConfig } from "@x402/core/server";
import type { Network } from "@x402/core/types";
import type { Express, RequestHandler } from "express";

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
  forwardRequestHeaders?: string[];
  forwardResponseHeaders?: string[];
  addRequestHeaders?: Record<string, string>;
  addResponseHeaders?: Record<string, string>;
};

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
};

/**
 * Root SDK configuration.
 */
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

/**
 * Public SDK instance contract.
 */
export type X402ProxySdk = {
  routes: Record<string, RouteConfig>;
  paymentMiddleware: RequestHandler;
  install: (app: Express) => void;
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
