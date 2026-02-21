import type { Express, RequestHandler } from "express";

import type { DiscoveryConfig, ProxyEndpointConfig } from "./types";
import { isHttpEndpoint, isWebSocketEndpoint } from "./types";

export type DiscoveryDocument = {
  version: 1;
  resources: string[];
  ownershipProofs?: string[];
  instructions?: string;
};

function toPublicResourceUrl(publicBaseUrl: string, path: string): string {
  return new URL(path, publicBaseUrl).toString();
}

/**
 * Build discovery document payload from configured protected endpoints.
 */
export function createDiscoveryDocument(
  discovery: DiscoveryConfig,
  endpoints: ProxyEndpointConfig[],
): DiscoveryDocument {
  const resources = new Set<string>();
  for (const endpoint of endpoints) {
    if (isHttpEndpoint(endpoint)) {
      resources.add(toPublicResourceUrl(discovery.publicBaseUrl, endpoint.publicPath));
      continue;
    }

    if (isWebSocketEndpoint(endpoint)) {
      resources.add(toPublicResourceUrl(discovery.publicBaseUrl, endpoint.leasePath));
    }
  }

  const document: DiscoveryDocument = {
    version: 1,
    resources: Array.from(resources).sort(),
  };
  if (discovery.ownershipProofs) {
    document.ownershipProofs = discovery.ownershipProofs;
  }
  if (discovery.instructions) {
    document.instructions = discovery.instructions;
  }
  return document;
}

/**
 * Create a request handler for both x402 discovery routes.
 */
export function createDiscoveryHandler(discovery: DiscoveryConfig, endpoints: ProxyEndpointConfig[]): RequestHandler {
  const payload = createDiscoveryDocument(discovery, endpoints);
  return (_req, res) => {
    res.status(200).json(payload);
  };
}

/**
 * Register discovery endpoints on the provided Express app.
 */
export function installDiscoveryEndpoints(
  app: Express,
  discovery: DiscoveryConfig | undefined,
  endpoints: ProxyEndpointConfig[],
): void {
  if (!discovery?.enabled) {
    return;
  }

  const handler = createDiscoveryHandler(discovery, endpoints);
  app.get("/.well-known/x402", handler);
  app.get("/x402-discovery.json", handler);
}
