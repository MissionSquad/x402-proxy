import type { RouteConfig } from "@x402/core/server";
import type { Network, Price } from "@x402/core/types";

import { RouteBuildError } from "./errors";
import type { HttpMethod } from "./types";

type BuildInput = {
  network: Network;
  payTo: string;
  publicResourceUrl?: (path: string) => string | undefined;
};

export type BuildEndpointRouteInput = {
  path: string;
  method: HttpMethod | "POST";
  price: Price;
  network: Network;
  payTo: string;
  description: string;
  mimeType?: string;
  maxTimeoutSeconds?: number;
  publicResourceUrl?: (path: string) => string | undefined;
};

/**
 * Build a single x402 route config for a paid endpoint.
 */
export function buildRouteConfig(
  path: string,
  price: Price,
  input: BuildInput,
  description: string,
  mimeType = "application/json",
  maxTimeoutSeconds = 60,
): RouteConfig {
  const routeConfig: RouteConfig = {
    accepts: {
      scheme: "exact",
      network: input.network,
      payTo: input.payTo,
      price,
      maxTimeoutSeconds,
      extra: {},
    },
    description,
    mimeType,
  };

  const resource = input.publicResourceUrl?.(path);
  if (resource) {
    routeConfig.resource = resource;
  }
  return routeConfig;
}

export function createHttpRouteKey(method: HttpMethod, path: string): string {
  return `${method} ${path}`;
}

export function createWsLeaseRouteKey(path: string): string {
  return `POST ${path}`;
}

/**
 * Build and index all payment-protected x402 routes used by middleware.
 */
export function buildRoutes(inputs: BuildEndpointRouteInput[]): Record<string, RouteConfig> {
  const routes: Record<string, RouteConfig> = {};
  for (const input of inputs) {
    const key = `${input.method} ${input.path}`;
    if (routes[key]) {
      throw new RouteBuildError("Duplicate x402 route key", { key });
    }

    const buildInput: BuildInput = {
      network: input.network,
      payTo: input.payTo,
    };
    if (input.publicResourceUrl) {
      buildInput.publicResourceUrl = input.publicResourceUrl;
    }

    routes[key] = buildRouteConfig(
      input.path,
      input.price,
      buildInput,
      input.description,
      input.mimeType,
      input.maxTimeoutSeconds ?? 60,
    );
  }

  return routes;
}
