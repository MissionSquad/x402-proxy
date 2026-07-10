import { randomUUID } from "node:crypto";

import { RouteBuildError, ValidationError } from "./errors";
import { isValidHttpHeaderName, isValidHttpHeaderValue, shouldDropProxyHeader } from "./headerPolicy";
import {
  extractRoutePlaceholders,
  findBestRouteMatch,
  findMisplacedUpstreamPlaceholders,
  parseRoutePattern,
  type CompiledRoutePattern,
} from "./routePattern";
import type {
  HttpMethod,
  X402AccessEvent,
  X402AccessEventStore,
  X402Resource,
  X402ResourceStore,
  X402ResourceValidationIssue,
} from "./types";

const NETWORK_REGEX = /^(eip155|solana):[A-Za-z0-9]+$/;
const POSITIVE_DECIMAL_REGEX = /^\d+(\.\d+)?$/;
const METHODS: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

type IndexedResource = {
  resource: X402Resource;
  method: string;
  routePattern: CompiledRoutePattern;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function validateWsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "wss:" || url.protocol === "ws:";
  } catch {
    return false;
  }
}

function validateUpstreamPlaceholders(resource: X402Resource, errors: string[]): void {
  let publicPattern: CompiledRoutePattern;
  try {
    publicPattern = parseRoutePattern(resource.publicPath, { allowWildcard: true });
  } catch (error: unknown) {
    errors.push(error instanceof Error ? error.message : "invalid publicPath");
    return;
  }

  // WebSocket upstream URLs are connected verbatim — no interpolation ever runs on them —
  // so any placeholder is a misconfiguration that would reach the upstream literally.
  if (resource.kind === "websocket") {
    for (const placeholder of extractRoutePlaceholders(resource.upstreamUrl)) {
      errors.push(`websocket upstreamUrl must not contain placeholder [${placeholder}]`);
    }
    return;
  }

  const publicParams = new Set(publicPattern.paramNames);
  for (const placeholder of extractRoutePlaceholders(resource.upstreamUrl)) {
    if (!publicParams.has(placeholder)) {
      errors.push(`upstreamUrl placeholder [${placeholder}] is not present in publicPath`);
    }
  }

  // Interpolation only substitutes placeholders occupying a full path segment; reject any
  // occurrence that would validate but never be substituted (partial segment, query, hash).
  for (const placeholder of findMisplacedUpstreamPlaceholders(resource.upstreamUrl) ?? []) {
    errors.push(`upstreamUrl placeholder [${placeholder}] must occupy a full path segment`);
  }
}

function validateAccess(resource: X402Resource, errors: string[]): void {
  if (!resource.access) {
    return;
  }
  if (!["pass-through", "service-token"].includes(resource.access.mode)) {
    errors.push("access.mode must be pass-through or service-token");
    return;
  }
  if (resource.access.mode !== "service-token") {
    return;
  }
  // The WebSocket gateway relays connections without header forwarding or injection,
  // so a service token configured on a websocket resource would never be applied.
  if (resource.kind === "websocket") {
    errors.push("access.mode service-token is not supported for websocket resources");
  }
  if (!isNonEmptyString(resource.access.serviceTokenHeader)) {
    errors.push("access.serviceTokenHeader is required for service-token mode");
  } else if (!isValidHttpHeaderName(resource.access.serviceTokenHeader)) {
    errors.push("access.serviceTokenHeader must be a valid HTTP header name (RFC 9110 token, no whitespace)");
  } else if (shouldDropProxyHeader(resource.access.serviceTokenHeader.toLowerCase())) {
    errors.push("access.serviceTokenHeader must not be a payment, hop-by-hop, host, or content-length header");
  }
  if (!isNonEmptyString(resource.access.serviceTokenValue)) {
    errors.push("access.serviceTokenValue is required for service-token mode");
  } else if (!isValidHttpHeaderValue(resource.access.serviceTokenValue)) {
    errors.push("access.serviceTokenValue must not contain control characters");
  }
}

export function validateX402Resource(resource: X402Resource): X402ResourceValidationIssue[] {
  const errors: string[] = [];

  if (!isNonEmptyString(resource.id)) {
    errors.push("id must be a non-empty string");
  }
  if (!["http", "http-stream", "http-stream-direct", "websocket"].includes(resource.kind)) {
    errors.push("kind must be http, http-stream, http-stream-direct, or websocket");
  }
  if (!METHODS.includes(resource.method)) {
    errors.push("method is not supported");
  }
  if (!isNonEmptyString(resource.publicPath) || !resource.publicPath.startsWith("/")) {
    errors.push("publicPath must start with /");
  }
  if (resource.kind === "websocket") {
    if (!validateWsUrl(resource.upstreamUrl)) {
      errors.push("websocket upstreamUrl must use ws: or wss:");
    }
  } else if (!validateHttpUrl(resource.upstreamUrl)) {
    errors.push("upstreamUrl must use http: or https:");
  }

  if (!POSITIVE_DECIMAL_REGEX.test(resource.pricing.amount) || Number.parseFloat(resource.pricing.amount) <= 0) {
    errors.push("pricing.amount must be a positive decimal string");
  }
  if (!NETWORK_REGEX.test(resource.pricing.network)) {
    errors.push("pricing.network must be CAIP-2 and use eip155:* or solana:*");
  }
  if (!isNonEmptyString(resource.pricing.payTo)) {
    errors.push("pricing.payTo must be a non-empty string");
  }

  if (resource.kind === "http-stream-direct" && resource.stream) {
    errors.push("stream config is not applicable to http-stream-direct resources (payment settles on the request itself; there is no lease)");
  }

  if (resource.match !== undefined) {
    if (resource.kind !== "http" && resource.kind !== "http-stream-direct") {
      errors.push("match is only supported on http and http-stream-direct resources");
    }
    if (!isNonEmptyString(resource.match.bodyField)) {
      errors.push("match.bodyField must be a non-empty string");
    }
    if (!isNonEmptyString(resource.match.equals)) {
      errors.push("match.equals must be a non-empty string");
    }
  }

  if (resource.kind === "http-stream" || resource.kind === "websocket") {
    if (!resource.stream) {
      errors.push("stream config is required for http-stream and websocket resources");
    } else {
      if (!resource.stream.leasePath.startsWith("/")) {
        errors.push("stream.leasePath must start with /");
      }
      if (resource.stream.leaseSeconds <= 0) {
        errors.push("stream.leaseSeconds must be > 0");
      }
      if (resource.stream.renewalWindowSeconds < 0) {
        errors.push("stream.renewalWindowSeconds must be >= 0");
      }
      try {
        parseRoutePattern(resource.stream.leasePath, { allowWildcard: false });
      } catch (error: unknown) {
        errors.push(error instanceof Error ? error.message : "invalid stream.leasePath");
      }
    }
  }

  validateUpstreamPlaceholders(resource, errors);
  validateAccess(resource, errors);

  return errors.map((reason) => ({ resourceId: resource.id || "unknown", reason }));
}

function createIndexedResource(resource: X402Resource): IndexedResource {
  return {
    resource,
    method: resource.method.toUpperCase(),
    routePattern: parseRoutePattern(resource.publicPath, { allowWildcard: true }),
  };
}

export class InMemoryX402ResourceStore implements X402ResourceStore {
  private resources: X402Resource[];

  private indexed: IndexedResource[];

  public constructor(resources: X402Resource[] = []) {
    this.resources = [];
    this.indexed = [];
    this.setResources(resources);
  }

  public setResources(resources: X402Resource[]): void {
    const invalid = resources.flatMap((resource) => validateX402Resource(resource));
    if (invalid.length > 0) {
      throw new ValidationError("Invalid in-memory x402 resources", { errors: invalid });
    }
    const seenRoutes = new Set<string>();
    const nextIndexed = resources
      .filter((resource) => resource.enabled)
      .map((resource) => {
        const indexed = createIndexedResource(resource);
        // Body-matched resources may legitimately share a publicPath; their claim is
        // path + discriminator value. Unmatched resources claim the whole path.
        const routeKey = resource.match
          ? `${indexed.method} ${indexed.routePattern.pattern} [${resource.match.bodyField}=${resource.match.equals}]`
          : `${indexed.method} ${indexed.routePattern.pattern}`;
        if (seenRoutes.has(routeKey)) {
          throw new RouteBuildError("Duplicate resource route", { routeKey });
        }
        seenRoutes.add(routeKey);
        return indexed;
      });

    this.resources = [...resources];
    this.indexed = nextIndexed;
  }

  public async listEnabledResources(): Promise<X402Resource[]> {
    return this.resources.filter((resource) => resource.enabled);
  }

  public async getResourceById(id: string): Promise<X402Resource | null> {
    return this.resources.find((resource) => resource.id === id) ?? null;
  }

  public async getResourceForRequest(method: string, path: string): Promise<X402Resource | null> {
    const candidates = this.indexed.filter((resource) => resource.method === method.toUpperCase());
    return findBestRouteMatch(candidates, path)?.candidate.resource ?? null;
  }
}

export class NoopX402AccessEventStore implements X402AccessEventStore {
  public async record(_event: X402AccessEvent): Promise<void> {
    return undefined;
  }
}

export class InMemoryX402AccessEventStore implements X402AccessEventStore {
  public readonly events: X402AccessEvent[] = [];

  public async record(event: X402AccessEvent): Promise<void> {
    this.events.push(event);
  }
}

export function createAccessEvent(input: Omit<X402AccessEvent, "id" | "createdAt">): X402AccessEvent {
  return {
    ...input,
    id: randomUUID(),
    createdAt: Date.now(),
  };
}
