import type { ProxyEndpointConfig, X402ProxySdkConfig } from "./types";
import { isHttpEndpoint, isWebSocketEndpoint } from "./types";
import { ValidationError } from "./errors";

const NETWORK_REGEX = /^(eip155|solana):[A-Za-z0-9]+$/;
const POSITIVE_DECIMAL_REGEX = /^\d+(\.\d+)?$/;

function isValidNetwork(network: string): boolean {
  return NETWORK_REGEX.test(network);
}

function isNonEmpty(value: string | undefined): boolean {
  return Boolean(value && value.trim().length > 0);
}

function validatePath(path: string, fieldName: string, endpointId: string): string | undefined {
  if (!path.startsWith("/")) {
    return `${fieldName} must start with "/" (${endpointId})`;
  }
  return undefined;
}

function validatePrice(price: string, endpointId: string): string | undefined {
  if (!POSITIVE_DECIMAL_REGEX.test(price)) {
    return `price must match /^\\d+(\\.\\d+)?$/ (${endpointId})`;
  }
  if (Number.parseFloat(price) <= 0) {
    return `price must be > 0 (${endpointId})`;
  }
  return undefined;
}

function validateHttpUrl(url: string, fieldName: string, endpointId: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return `${fieldName} must use http: or https: (${endpointId})`;
    }
    return undefined;
  } catch {
    return `${fieldName} must be a valid URL (${endpointId})`;
  }
}

function validateWsUrl(url: string, fieldName: string, endpointId: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "wss:" && parsed.protocol !== "ws:") {
      return `${fieldName} must use ws: or wss: (${endpointId})`;
    }
    return undefined;
  } catch {
    return `${fieldName} must be a valid URL (${endpointId})`;
  }
}

function validateEndpoint(
  endpoint: ProxyEndpointConfig,
  defaultNetwork: string,
  errors: string[],
  seenHttpRoutes: Set<string>,
  seenLeasePaths: Set<string>,
  seenWsPaths: Set<string>,
): void {
  if (!isNonEmpty(endpoint.id)) {
    errors.push("endpoint id must be a non-empty string");
  }

  const networkToCheck = endpoint.network ?? defaultNetwork;
  if (!isValidNetwork(networkToCheck)) {
    errors.push(`network must be CAIP-2 and use eip155:* or solana:* (${endpoint.id})`);
  }

  if (endpoint.payTo !== undefined && !isNonEmpty(endpoint.payTo)) {
    errors.push(`payTo must be a non-empty string when provided (${endpoint.id})`);
  }

  const priceError = validatePrice(endpoint.price, endpoint.id);
  if (priceError) {
    errors.push(priceError);
  }

  if (isHttpEndpoint(endpoint)) {
    const pathError = validatePath(endpoint.publicPath, "publicPath", endpoint.id);
    if (pathError) {
      errors.push(pathError);
    }

    const upstreamError = validateHttpUrl(endpoint.upstreamUrl, "upstreamUrl", endpoint.id);
    if (upstreamError) {
      errors.push(upstreamError);
    }

    const routeKey = `${endpoint.method.toUpperCase()} ${endpoint.publicPath}`;
    if (seenHttpRoutes.has(routeKey)) {
      errors.push(`duplicate HTTP route ${routeKey}`);
    } else {
      seenHttpRoutes.add(routeKey);
    }
  }

  if (isWebSocketEndpoint(endpoint)) {
    const leasePathError = validatePath(endpoint.leasePath, "leasePath", endpoint.id);
    if (leasePathError) {
      errors.push(leasePathError);
    }

    const wsPathError = validatePath(endpoint.wsPath, "wsPath", endpoint.id);
    if (wsPathError) {
      errors.push(wsPathError);
    }

    const upstreamWsError = validateWsUrl(endpoint.upstreamWsUrl, "upstreamWsUrl", endpoint.id);
    if (upstreamWsError) {
      errors.push(upstreamWsError);
    }

    if (endpoint.leaseSeconds <= 0) {
      errors.push(`leaseSeconds must be > 0 (${endpoint.id})`);
    }

    if (seenLeasePaths.has(endpoint.leasePath)) {
      errors.push(`duplicate websocket leasePath ${endpoint.leasePath}`);
    } else {
      seenLeasePaths.add(endpoint.leasePath);
    }

    if (seenWsPaths.has(endpoint.wsPath)) {
      errors.push(`duplicate websocket wsPath ${endpoint.wsPath}`);
    } else {
      seenWsPaths.add(endpoint.wsPath);
    }
  }
}

/**
 * Validate SDK configuration and throw a typed error on first startup.
 *
 * @throws ValidationError When configuration is invalid.
 */
export function validateProxySdkConfig(config: X402ProxySdkConfig): void {
  const errors: string[] = [];

  if (!isNonEmpty(config.leaseTokenSecret) || config.leaseTokenSecret.length < 32) {
    errors.push("leaseTokenSecret must be at least 32 characters");
  }

  if (!Array.isArray(config.endpoints) || config.endpoints.length === 0) {
    errors.push("endpoints must contain at least one endpoint");
  }

  if (!isValidNetwork(config.defaultNetwork)) {
    errors.push("defaultNetwork must be CAIP-2 and use eip155:* or solana:*");
  }

  if (!isNonEmpty(config.defaultPayTo)) {
    errors.push("defaultPayTo must be a non-empty string");
  }

  const seenIds = new Set<string>();
  const seenHttpRoutes = new Set<string>();
  const seenLeasePaths = new Set<string>();
  const seenWsPaths = new Set<string>();
  for (const endpoint of config.endpoints) {
    if (seenIds.has(endpoint.id)) {
      errors.push(`duplicate endpoint id ${endpoint.id}`);
    } else {
      seenIds.add(endpoint.id);
    }

    validateEndpoint(
      endpoint,
      config.defaultNetwork,
      errors,
      seenHttpRoutes,
      seenLeasePaths,
      seenWsPaths,
    );
  }

  if (config.discovery?.enabled) {
    if (!isNonEmpty(config.discovery.publicBaseUrl)) {
      errors.push("discovery.publicBaseUrl must be provided when discovery is enabled");
    } else {
      try {
        const url = new URL(config.discovery.publicBaseUrl);
        if (url.protocol !== "https:" && url.protocol !== "http:") {
          errors.push("discovery.publicBaseUrl must use http: or https:");
        }
      } catch {
        errors.push("discovery.publicBaseUrl must be a valid URL");
      }
    }
  }

  if (errors.length > 0) {
    throw new ValidationError("Invalid x402 proxy SDK configuration", { errors });
  }
}
