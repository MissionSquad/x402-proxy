import type { Network, Price } from "@x402/core/types";
import type { Express, RequestHandler } from "express";

import { resolvePrice } from "./currency";
import { installDiscoveryEndpoints } from "./discovery";
import { createHttpProxyHandler } from "./httpProxy";
import { createPaymentMiddleware } from "./payment";
import { buildRoutes, type BuildEndpointRouteInput } from "./routeBuilder";
import { endpointToResource, X402ResourceRuntime } from "./resourceRuntime";
import { InMemoryX402ResourceStore } from "./resourceStore";
import {
  isHttpEndpoint,
  isWebSocketEndpoint,
  type HttpMethod,
  type HttpProxyEndpointConfig,
  type ProxyEndpointConfig,
  type WebSocketProxyEndpointConfig,
  type X402ProxySdk,
  type X402ProxySdkConfig,
} from "./types";
import { validateProxySdkConfig } from "./validation";
import { createLeaseHandler } from "./wsLease";
import { createResourceServer } from "./x402Server";

type ResolvedHttpEndpoint = HttpProxyEndpointConfig & {
  network: Network;
  payTo: string;
  resolvedPrice: Price;
};

type ResolvedWebSocketEndpoint = WebSocketProxyEndpointConfig & {
  network: Network;
  payTo: string;
  resolvedPrice: Price;
};

type ResolvedEndpoint = ResolvedHttpEndpoint | ResolvedWebSocketEndpoint;

function resolveEndpointDefaults(endpoint: ProxyEndpointConfig, config: X402ProxySdkConfig): ResolvedEndpoint {
  const network = endpoint.network ?? config.defaultNetwork;
  const payTo = endpoint.payTo ?? config.defaultPayTo;
  const resolvedPrice = resolvePrice(network, endpoint.price, endpoint.currency);

  if (isHttpEndpoint(endpoint)) {
    return {
      ...endpoint,
      network,
      payTo,
      resolvedPrice,
    };
  }

  if (isWebSocketEndpoint(endpoint)) {
    return {
      ...endpoint,
      network,
      payTo,
      resolvedPrice,
    };
  }

  throw new Error("Unsupported endpoint kind");
}

function toRouteDescription(endpoint: ResolvedEndpoint): string {
  if (endpoint.description) {
    return endpoint.description;
  }
  if (endpoint.kind === "http") {
    return `Paid HTTP access for ${endpoint.id}`;
  }
  return `Paid WebSocket lease for ${endpoint.id}`;
}

function buildPublicResourceUrlFactory(config: X402ProxySdkConfig): ((path: string) => string | undefined) | undefined {
  if (!config.discovery?.enabled) {
    return undefined;
  }
  const publicBaseUrl = config.discovery.publicBaseUrl;

  return (path: string) => new URL(path, publicBaseUrl).toString();
}

function buildRouteInputs(
  config: X402ProxySdkConfig,
  endpoints: ResolvedEndpoint[],
): BuildEndpointRouteInput[] {
  const publicResourceUrl = buildPublicResourceUrlFactory(config);
  const routeInputs: BuildEndpointRouteInput[] = [];

  for (const endpoint of endpoints) {
    if (endpoint.kind === "http") {
      const routeInput: BuildEndpointRouteInput = {
        path: endpoint.publicPath,
        method: endpoint.method,
        price: endpoint.resolvedPrice,
        network: endpoint.network,
        payTo: endpoint.payTo,
        description: toRouteDescription(endpoint),
      };
      if (endpoint.mimeType) {
        routeInput.mimeType = endpoint.mimeType;
      }
      if (endpoint.maxTimeoutSeconds !== undefined) {
        routeInput.maxTimeoutSeconds = endpoint.maxTimeoutSeconds;
      }
      if (publicResourceUrl) {
        routeInput.publicResourceUrl = publicResourceUrl;
      }
      routeInputs.push(routeInput);
      continue;
    }

    const routeInput: BuildEndpointRouteInput = {
      path: endpoint.leasePath,
      method: "POST",
      price: endpoint.resolvedPrice,
      network: endpoint.network,
      payTo: endpoint.payTo,
      description: toRouteDescription(endpoint),
    };
    if (endpoint.mimeType) {
      routeInput.mimeType = endpoint.mimeType;
    }
    if (endpoint.maxTimeoutSeconds !== undefined) {
      routeInput.maxTimeoutSeconds = endpoint.maxTimeoutSeconds;
    }
    if (publicResourceUrl) {
      routeInput.publicResourceUrl = publicResourceUrl;
    }
    routeInputs.push(routeInput);
  }

  return routeInputs;
}

function registerMethodRoute(app: Express, method: HttpMethod | "POST", path: string, handler: RequestHandler): void {
  switch (method) {
    case "GET":
      app.get(path, handler);
      return;
    case "POST":
      app.post(path, handler);
      return;
    case "PUT":
      app.put(path, handler);
      return;
    case "PATCH":
      app.patch(path, handler);
      return;
    case "DELETE":
      app.delete(path, handler);
      return;
    case "HEAD":
      app.head(path, handler);
      return;
    case "OPTIONS":
      app.options(path, handler);
      return;
    default: {
      const exhaustive: never = method;
      throw new Error(`Unsupported method: ${String(exhaustive)}`);
    }
  }
}

function installHttpEndpoints(app: Express, endpoints: ResolvedEndpoint[], config: X402ProxySdkConfig): void {
  for (const endpoint of endpoints) {
    if (endpoint.kind !== "http") {
      continue;
    }
    const handler = createHttpProxyHandler(endpoint, config.security);
    registerMethodRoute(app, endpoint.method, endpoint.publicPath, handler);
  }
}

function installWebSocketLeaseEndpoints(
  app: Express,
  endpoints: ResolvedEndpoint[],
  config: X402ProxySdkConfig,
): void {
  for (const endpoint of endpoints) {
    if (endpoint.kind !== "websocket") {
      continue;
    }

    const leaseHandlerInput: Parameters<typeof createLeaseHandler>[0] = {
      endpoint,
      secret: config.leaseTokenSecret,
    };
    if (config.discovery?.publicBaseUrl) {
      leaseHandlerInput.publicBaseUrl = config.discovery.publicBaseUrl;
    }
    const leaseHandler = createLeaseHandler(leaseHandlerInput);
    app.post(endpoint.leasePath, leaseHandler);

    app.get(endpoint.wsPath, (_req, res) => {
      res.status(426).json({ error: "Upgrade Required: connect via WebSocket with lease token" });
    });
  }
}

/**
 * Create configured x402 proxy SDK instance.
 */
export function createX402ProxySdk(config: X402ProxySdkConfig): X402ProxySdk {
  validateProxySdkConfig(config);

  const configuredEndpoints = config.endpoints ?? [];
  const resolvedEndpoints = configuredEndpoints.map((endpoint) => resolveEndpointDefaults(endpoint, config));
  const routeInputs = buildRouteInputs(config, resolvedEndpoints);
  const routes = buildRoutes(routeInputs);

  const server = createResourceServer(config.facilitator?.url, config.facilitator?.authorizationBearer);
  const paymentMiddleware = createPaymentMiddleware(routes, server, config.syncFacilitatorOnStart ?? true);
  const staticResources = configuredEndpoints.map((endpoint) =>
    endpointToResource(endpoint, { network: config.defaultNetwork, payTo: config.defaultPayTo }),
  );
  const resourceStore = config.resourceStore ?? new InMemoryX402ResourceStore(staticResources);
  const runtimeInput: ConstructorParameters<typeof X402ResourceRuntime>[0] = {
    store: resourceStore,
    resourceServer: server,
    leaseTokenSecret: config.leaseTokenSecret,
    syncFacilitatorOnStart: config.syncFacilitatorOnStart ?? true,
    requireProtectedResources: config.requireProtectedResources ?? true,
  };
  if (config.security) {
    runtimeInput.security = config.security;
  }
  if (config.discovery) {
    runtimeInput.discovery = config.discovery;
  }
  if (config.facilitator?.url) {
    runtimeInput.facilitatorUrl = config.facilitator.url;
  }
  if (config.accessEventStore) {
    runtimeInput.accessEventStore = config.accessEventStore;
  }
  if (!config.resourceStore) {
    runtimeInput.initialResources = staticResources;
  }
  const resourceRuntime = new X402ResourceRuntime(runtimeInput);

  return {
    routes,
    paymentMiddleware,
    refreshResources: () => resourceRuntime.refreshResources(),
    listLoadedResources: () => resourceRuntime.listLoadedResources(),
    diagnostics: () => resourceRuntime.diagnostics(),
    install(app: Express): void {
      installDiscoveryEndpoints(app, config.discovery, configuredEndpoints, resourceRuntime);
      resourceRuntime.install(app);
    },
  };
}
