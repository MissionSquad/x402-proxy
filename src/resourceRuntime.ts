import { ExpressAdapter } from "@x402/express";
import {
  x402HTTPResourceServer,
  type HTTPProcessResult,
  type PaywallConfig,
  type PaywallProvider,
  type RouteConfig,
} from "@x402/core/server";
import type { PaymentRequirements, PaymentPayload, Network } from "@x402/core/types";
import type { Express, Request, RequestHandler, Response } from "express";

import { resolvePrice } from "./currency";
import {
  FacilitatorSyncError,
  LeaseTokenError,
  RequestBodyTooLargeError,
  ResourceRouteSyncError,
  RouteBuildError,
  SecurityPolicyError,
  UpstreamRequestError,
  UpstreamTimeoutError,
  X402ProxyError,
} from "./errors";
import {
  isAbortError,
  proxyBufferedHttpRequest,
  proxyStreamingHttpRequest,
  sendBufferedProxyResponse,
} from "./httpProxy";
import { buildRouteConfig } from "./routeBuilder";
import {
  findBestRouteMatch,
  parseRoutePattern,
  type CompiledRoutePattern,
  type RouteMatch,
} from "./routePattern";
import { createAccessEvent, NoopX402AccessEventStore, validateX402Resource } from "./resourceStore";
import {
  InMemoryX402LeaseUseStore,
  issueHttpStreamLease,
  verifyHttpStreamLeaseToken,
  type X402LeaseUseStore,
} from "./streamLease";
import { issueLease } from "./wsLease";
import type {
  DiscoveryConfig,
  HttpMethod,
  ProxyEndpointConfig,
  X402AccessEvent,
  X402AccessEventStore,
  X402LoadedResource,
  X402ProxyDiagnostics,
  X402Resource,
  X402ResourceMatch,
  X402ResourceRefreshResult,
  X402ResourceStore,
  X402ResourceValidationIssue,
} from "./types";
import { isHttpEndpoint, isWebSocketEndpoint } from "./types";
import type { SecurityConfig } from "./types";
import type { x402ResourceServer } from "@x402/core/server";

type LoadedResourceInternal = {
  resource: X402Resource;
  routePattern: CompiledRoutePattern;
  leasePattern?: CompiledRoutePattern;
};

export type X402ResourceRuntimeOptions = {
  store: X402ResourceStore;
  resourceServer: x402ResourceServer;
  leaseTokenSecret: string;
  security?: SecurityConfig;
  discovery?: DiscoveryConfig;
  syncFacilitatorOnStart: boolean;
  requireProtectedResources: boolean;
  facilitatorUrl?: string;
  accessEventStore?: X402AccessEventStore;
  leaseUseStore?: X402LeaseUseStore;
  initialResources?: X402Resource[];
  paywall?: PaywallProvider;
  paywallConfig?: PaywallConfig;
};

type PaymentVerifiedResult = Extract<HTTPProcessResult, { type: "payment-verified" }>;

/**
 * Outcome of the payment phase for a matched paid resource:
 * - "verified": a valid payment was presented; the caller settles, then serves.
 * - "granted": a protected-request hook granted access; serve WITHOUT settlement.
 * - "responded": a response (402 challenge, payment error, 503) was already sent.
 */
type ProcessPaymentOutcome =
  | { kind: "verified"; payment: PaymentVerifiedResult }
  | { kind: "granted" }
  | { kind: "responded" };

function toPaymentPath(resource: X402Resource): string {
  if (resource.kind === "http" || resource.kind === "http-stream-direct") {
    return resource.publicPath;
  }
  if (!resource.stream) {
    throw new RouteBuildError("Stream resource is missing lease config", { resourceId: resource.id });
  }
  return resource.stream.leasePath;
}

function toPaymentMethod(resource: X402Resource): HttpMethod | "POST" {
  return resource.kind === "http" || resource.kind === "http-stream-direct" ? resource.method : "POST";
}

/**
 * Path under which a body-matched resource's payment route is registered. Resources
 * with a `match` discriminator share their real publicPath, so the @x402/core route
 * table (which is path-keyed) needs a unique synthetic key per resource. The synthetic
 * path is only ever used as a route-table key and as `context.path` during payment
 * processing — the 402 challenge advertises the real request URL, because @x402/core
 * falls back to `adapter.getUrl()` when `RouteConfig.resource` is unset, and explicit
 * discovery URLs are built from the real publicPath.
 */
function toSyntheticMatchPath(resource: X402Resource): string {
  return `/__x402/match/${encodeURIComponent(resource.id)}`;
}

/**
 * Key for the @x402/core route table AND the `context.path` used when processing a
 * payment for this resource. Must be unique across loaded resources.
 */
function toPaymentRoutePath(resource: X402Resource): string {
  return resource.match ? toSyntheticMatchPath(resource) : toPaymentPath(resource);
}

function toPaymentRouteKey(resource: X402Resource): string {
  return `${toPaymentMethod(resource)} ${toPaymentRoutePath(resource)}`;
}

function toRouteDescription(resource: X402Resource): string {
  if (resource.kind === "http") {
    return `Paid HTTP access for ${resource.id}`;
  }
  if (resource.kind === "http-stream-direct") {
    return `Paid HTTP stream for ${resource.id}`;
  }
  if (resource.kind === "http-stream") {
    return `Paid HTTP stream lease for ${resource.id}`;
  }
  return `Paid WebSocket lease for ${resource.id}`;
}

function publicUrlFactory(discovery?: DiscoveryConfig): ((path: string) => string | undefined) | undefined {
  if (!discovery?.enabled) {
    return undefined;
  }
  return (path: string) => new URL(path, discovery.publicBaseUrl).toString();
}

function toRouteConfig(resource: X402Resource, discovery?: DiscoveryConfig): RouteConfig {
  const currency: { asset?: string; decimals?: number } = {};
  if (resource.pricing.asset !== undefined) {
    currency.asset = resource.pricing.asset;
  }
  if (resource.pricing.decimals !== undefined) {
    currency.decimals = resource.pricing.decimals;
  }
  const hasCurrencyOverride = resource.pricing.asset !== undefined || resource.pricing.decimals !== undefined;
  const price = resolvePrice(
    resource.pricing.network,
    resource.pricing.amount,
    hasCurrencyOverride ? currency : undefined,
  );
  const routePath = toPaymentPath(resource);
  const buildInput: {
    network: Network;
    payTo: string;
    publicResourceUrl?: (path: string) => string | undefined;
  } = {
    network: resource.pricing.network,
    payTo: resource.pricing.payTo,
  };
  const resourceUrl = publicUrlFactory(discovery);
  if (resourceUrl) {
    buildInput.publicResourceUrl = resourceUrl;
  }
  return buildRouteConfig(
    routePath,
    price,
    buildInput,
    toRouteDescription(resource),
    "application/json",
    60,
  );
}

function toLoadedResource(resource: X402Resource): X402LoadedResource {
  const loaded: X402LoadedResource = {
    id: resource.id,
    kind: resource.kind,
    method: resource.method,
    publicPath: resource.publicPath,
    paymentPath: toPaymentPath(resource),
    upstreamUrl: resource.upstreamUrl,
    enabled: resource.enabled,
    createdAt: resource.createdAt,
    updatedAt: resource.updatedAt,
  };
  if (resource.match) {
    loaded.match = resource.match;
  }
  return loaded;
}

/**
 * Shape of @x402/core's RouteConfigurationError: one entry per route whose payment
 * option has no registered scheme or no facilitator support. Detected structurally —
 * the class is not exported in a way that survives bundling.
 */
type RouteConfigurationIssue = { routePattern: string; message: string };

/**
 * Kick off the facilitator /supported sync with a detached rejection guard: without
 * it, a sync failure before any payment request awaits the promise is an unhandled
 * rejection (fatal under Node's default --unhandled-rejections=throw). The original
 * promise is returned so awaiting callers still observe the failure.
 */
function startFacilitatorSync(server: x402HTTPResourceServer): Promise<void> {
  const sync = server.initialize();
  sync.catch(() => {});
  return sync;
}

function matchesRequestBody(req: Request, match: X402ResourceMatch): boolean {
  const body: unknown = (req as Request & { body?: unknown }).body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return false;
  }
  const value = (body as Record<string, unknown>)[match.bodyField];
  return typeof value === "string" && value === match.equals;
}

function getRouteConfigurationIssues(error: unknown): RouteConfigurationIssue[] | null {
  if (!(error instanceof Error) || error.name !== "RouteConfigurationError") {
    return null;
  }
  const value = (error as Error & { errors?: unknown }).errors;
  if (!Array.isArray(value)) {
    return null;
  }
  const issues: RouteConfigurationIssue[] = [];
  for (const entry of value) {
    if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as { routePattern?: unknown }).routePattern === "string" &&
      typeof (entry as { message?: unknown }).message === "string"
    ) {
      issues.push({
        routePattern: (entry as { routePattern: string }).routePattern,
        message: (entry as { message: string }).message,
      });
    }
  }
  return issues.length > 0 ? issues : null;
}

function inferRequestBaseUrl(req: Request, configuredPublicBaseUrl?: string): URL {
  if (configuredPublicBaseUrl) {
    return new URL(configuredPublicBaseUrl);
  }
  const host = req.get("host");
  if (!host) {
    throw new LeaseTokenError("Unable to infer public base URL from request headers");
  }
  return new URL(`${req.protocol}://${host}`);
}

function getLeaseToken(req: Request): string | null {
  const header = req.get("x-x402-lease");
  if (header) {
    return header;
  }
  const value = req.query.t;
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }
  return null;
}

function applySettlementHeaders(res: Response, settleResult: { headers: Record<string, string> }): void {
  for (const [key, value] of Object.entries(settleResult.headers)) {
    res.setHeader(key, value);
  }
}

function sendPaymentError(res: Response, result: Extract<HTTPProcessResult, { type: "payment-error" }>): void {
  const { response } = result;
  res.status(response.status);
  for (const [key, value] of Object.entries(response.headers)) {
    res.setHeader(key, value);
  }
  if (response.isHtml) {
    res.send(response.body);
    return;
  }
  res.json(response.body ?? {});
}

function getPayer(paymentResult: PaymentVerifiedResult): string | undefined {
  const payload = paymentResult.paymentPayload as PaymentPayload & { payer?: string };
  return typeof payload.payer === "string" ? payload.payer : undefined;
}

function getTransaction(settleResult: unknown): string | undefined {
  if (!settleResult || typeof settleResult !== "object") {
    return undefined;
  }
  const value = settleResult as { transaction?: unknown; transactionHash?: unknown };
  if (typeof value.transaction === "string") {
    return value.transaction;
  }
  if (typeof value.transactionHash === "string") {
    return value.transactionHash;
  }
  return undefined;
}

/**
 * Map an error thrown during request handling to a clean JSON response. Never leaks stack
 * traces or internal error context, guards against writing to an already-committed response,
 * and gives every error a stable status + code contract.
 */
export function sendProxyErrorResponse(res: Response, error: unknown): void {
  // If the response has already started, there is nothing safe to send.
  if (res.headersSent) {
    return;
  }
  if (error instanceof SecurityPolicyError) {
    res.status(403).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof RequestBodyTooLargeError) {
    res.status(413).json({ error: error.message, code: error.code });
    return;
  }
  if (isAbortError(error)) {
    res.status(504).json({ error: "Upstream request timed out", code: "UPSTREAM_TIMEOUT_ERROR" });
    return;
  }
  if (error instanceof UpstreamRequestError || error instanceof UpstreamTimeoutError) {
    res.status(502).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof LeaseTokenError) {
    res.status(401).json({ error: "Invalid x402 lease token", code: error.code });
    return;
  }
  // Retryable operational conditions: facilitator sync failure and the brief
  // refresh-race window get 503 so clients know to simply try again.
  if (error instanceof FacilitatorSyncError || error instanceof ResourceRouteSyncError) {
    res.status(503).json({ error: error.message, code: error.code });
    return;
  }
  // Any other typed proxy error (RouteBuildError, ValidationError, PriceConversionError,
  // ConfigurationError) is an operational/config fault: 500 with a code, no stack.
  if (error instanceof X402ProxyError) {
    res.status(500).json({ error: error.message, code: error.code });
    return;
  }
  // Unknown errors: emit a generic 500 (no stack/details) rather than deferring to the host
  // app's default handler, which may serialize the stack outside production.
  res.status(500).json({ error: "Internal proxy error", code: "INTERNAL_ERROR" });
}

export class X402ResourceRuntime {
  private readonly store: X402ResourceStore;

  private readonly resourceServer: x402ResourceServer;

  private readonly eventStore: X402AccessEventStore;

  private readonly leaseUseStore: X402LeaseUseStore;

  private readonly leaseTokenSecret: string;

  private readonly security: SecurityConfig | undefined;

  private readonly discovery: DiscoveryConfig | undefined;

  private readonly syncFacilitatorOnStart: boolean;

  private readonly requireProtectedResources: boolean;

  private readonly facilitatorUrl: string | undefined;

  private readonly paywall: PaywallProvider | undefined;

  private readonly paywallConfig: PaywallConfig | undefined;

  private loaded: LoadedResourceInternal[] = [];

  private invalid: X402ResourceValidationIssue[] = [];

  private lastRefreshAt: number | undefined;

  private httpServer: x402HTTPResourceServer | null = null;

  private routes: Record<string, RouteConfig> = {};

  private initPromise: Promise<void> | null = null;

  private needsFacilitatorSync = false;

  private facilitatorSyncError: string | undefined;

  public constructor(options: X402ResourceRuntimeOptions) {
    this.store = options.store;
    this.resourceServer = options.resourceServer;
    this.eventStore = options.accessEventStore ?? new NoopX402AccessEventStore();
    this.leaseUseStore = options.leaseUseStore ?? new InMemoryX402LeaseUseStore();
    this.leaseTokenSecret = options.leaseTokenSecret;
    this.security = options.security;
    this.discovery = options.discovery;
    this.syncFacilitatorOnStart = options.syncFacilitatorOnStart;
    this.requireProtectedResources = options.requireProtectedResources;
    this.facilitatorUrl = options.facilitatorUrl;
    // Must be assigned before loadResources below — it registers the provider on the
    // freshly created HTTP server.
    this.paywall = options.paywall;
    this.paywallConfig = options.paywallConfig;
    if (options.initialResources) {
      this.loadResources(options.initialResources, Date.now());
    }
  }

  private loadResources(resources: X402Resource[], refreshedAt: number): X402ResourceRefreshResult {
    const invalid: X402ResourceValidationIssue[] = [];
    const seenPaymentRoutes = new Set<string>();
    const seenPublicClaims = new Set<string>();
    const loaded: LoadedResourceInternal[] = [];
    const routes: Record<string, RouteConfig> = {};

    for (const resource of resources) {
      const issues = validateX402Resource(resource);
      if (issues.length > 0) {
        invalid.push(...issues);
        continue;
      }

      try {
        const routePattern = parseRoutePattern(resource.publicPath, { allowWildcard: true });
        const internal: LoadedResourceInternal = { resource, routePattern };
        if (resource.stream) {
          internal.leasePattern = parseRoutePattern(resource.stream.leasePath, { allowWildcard: false });
        }
        const paymentRoute = toPaymentRouteKey(resource);
        // Human-readable claim on the public surface: body-matched resources may share a
        // publicPath but must have distinct discriminator values; unmatched resources
        // must have distinct method+path claims.
        const publicClaim = resource.match
          ? `${resource.method} ${resource.publicPath} [${resource.match.bodyField}=${resource.match.equals}]`
          : `${resource.method} ${resource.publicPath}`;
        if (seenPaymentRoutes.has(paymentRoute) || seenPublicClaims.has(publicClaim)) {
          invalid.push({ resourceId: resource.id, reason: `duplicate payment route ${publicClaim}` });
          continue;
        }
        seenPaymentRoutes.add(paymentRoute);
        seenPublicClaims.add(publicClaim);
        routes[paymentRoute] = toRouteConfig(resource, this.discovery);
        loaded.push(internal);
      } catch (error: unknown) {
        invalid.push({
          resourceId: resource.id,
          reason: error instanceof Error ? error.message : "invalid resource",
        });
      }
    }

    if (loaded.length === 0 && this.requireProtectedResources) {
      throw new RouteBuildError("No valid x402 resources loaded", { invalid });
    }

    this.loaded = loaded;
    this.invalid = invalid;
    this.lastRefreshAt = refreshedAt;
    this.routes = routes;
    this.rebuildHttpServer();

    return {
      loaded: loaded.map((item) => toLoadedResource(item.resource)),
      invalid,
      refreshedAt,
    };
  }

  /**
   * (Re)create the @x402/core HTTP server from the current route table and schedule a
   * facilitator sync. Called on every refresh and after pruning unsupported routes.
   */
  private rebuildHttpServer(): void {
    this.httpServer = new x402HTTPResourceServer(this.resourceServer, this.routes);
    if (this.paywall) {
      // The HTTP server is recreated on every rebuild, so the paywall provider must be
      // re-registered each time.
      this.httpServer.registerPaywallProvider(this.paywall);
    }
    this.facilitatorSyncError = undefined;
    this.needsFacilitatorSync = this.syncFacilitatorOnStart;
    this.initPromise = this.syncFacilitatorOnStart ? startFacilitatorSync(this.httpServer) : null;
  }

  /**
   * Remove routes @x402/core reported as unsupported (no registered scheme, or the
   * facilitator does not support the network/scheme), moving their resources to the
   * invalid list so one misconfigured resource cannot poison the rest of the paid
   * surface. Returns true when at least one route was pruned.
   */
  private pruneUnsupportedRoutes(issues: RouteConfigurationIssue[]): boolean {
    let pruned = false;
    for (const issue of issues) {
      const index = this.loaded.findIndex((item) => toPaymentRouteKey(item.resource) === issue.routePattern);
      if (index === -1) {
        continue;
      }
      const removed = this.loaded.splice(index, 1)[0];
      if (!removed) {
        continue;
      }
      this.invalid.push({ resourceId: removed.resource.id, reason: issue.message });
      delete this.routes[issue.routePattern];
      pruned = true;
    }
    if (pruned) {
      this.rebuildHttpServer();
    }
    return pruned;
  }

  public async refreshResources(): Promise<X402ResourceRefreshResult> {
    const resources = await this.store.listEnabledResources();
    return this.loadResources(resources, Date.now());
  }

  public listLoadedResources(): X402LoadedResource[] {
    return this.loaded.map((item) => toLoadedResource(item.resource));
  }

  public diagnostics(): X402ProxyDiagnostics {
    const networks = new Set<Network>();
    for (const resource of this.loaded) {
      networks.add(resource.resource.pricing.network);
    }
    const diagnostics: X402ProxyDiagnostics = {
      loadedResourceCount: this.loaded.length,
      invalidResourceCount: this.invalid.length,
      invalidResources: [...this.invalid],
      enabledNetworks: Array.from(networks).sort(),
      storeType: this.store.constructor.name,
    };
    if (this.lastRefreshAt !== undefined) {
      diagnostics.lastRefreshAt = this.lastRefreshAt;
    }
    if (this.facilitatorUrl) {
      diagnostics.facilitatorUrl = this.facilitatorUrl;
    }
    if (this.facilitatorSyncError !== undefined) {
      diagnostics.facilitatorSyncError = this.facilitatorSyncError;
    }
    return diagnostics;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.httpServer) {
      return;
    }
    await this.refreshResources();
  }

  /**
   * Await the pending facilitator sync, if any. On failure caused by unsupported
   * routes, prune them (per-resource isolation) and retry; the loop is bounded because
   * every prune removes at least one route. On any other failure (e.g. facilitator
   * unreachable) the sync is cleared so the NEXT payment request retries it, the
   * failure is surfaced in diagnostics, and the current request fails 503.
   */
  private async ensureInitialized(): Promise<void> {
    for (;;) {
      if (!this.needsFacilitatorSync || !this.httpServer) {
        return;
      }
      if (!this.initPromise) {
        this.initPromise = startFacilitatorSync(this.httpServer);
      }
      const pending = this.initPromise;
      try {
        await pending;
        // A refresh may have replaced the sync while we awaited; only settle our own.
        if (this.initPromise === pending) {
          this.initPromise = null;
          this.needsFacilitatorSync = false;
          this.facilitatorSyncError = undefined;
        }
        return;
      } catch (error: unknown) {
        if (this.initPromise === pending) {
          this.initPromise = null;
        }
        const issues = getRouteConfigurationIssues(error);
        if (issues && this.pruneUnsupportedRoutes(issues)) {
          continue;
        }
        const reason = error instanceof Error ? error.message : String(error);
        this.facilitatorSyncError = reason;
        throw new FacilitatorSyncError("Facilitator sync failed; payments are temporarily unavailable", {
          reason,
        });
      }
    }
  }

  /**
   * Record an access event without ever letting a failing audit store affect the
   * user-facing result of a paid request. Audit writes are best-effort.
   */
  private async recordEvent(event: X402AccessEvent): Promise<void> {
    try {
      await this.eventStore.record(event);
    } catch {
      // Audit failures must not turn a successful (or already-handled) request into an error.
    }
  }

  private async processPayment(req: Request, res: Response, resource: X402Resource): Promise<ProcessPaymentOutcome> {
    await this.ensureLoaded();
    await this.ensureInitialized();
    // Capture one generation AFTER the sync (which may rebuild the server via pruning).
    // routes and httpServer are always assigned together, so this pair is internally
    // consistent even if a refresh swaps generations mid-request.
    const httpServer = this.httpServer;
    const routes = this.routes;
    const routeKey = toPaymentRouteKey(resource);
    if (!httpServer || !(routeKey in routes)) {
      // The matched resource has no payment route in the current generation — either
      // the brief refresh-race window or the resource was just pruned. Retryable.
      sendProxyErrorResponse(
        res,
        new ResourceRouteSyncError("Resource routes are refreshing; retry the request", {
          resourceId: resource.id,
        }),
      );
      return { kind: "responded" };
    }

    const adapter = new ExpressAdapter(req);
    const context: {
      adapter: ExpressAdapter;
      path: string;
      method: string;
      paymentHeader?: string;
    } = {
      adapter,
      // Body-matched resources are registered under a synthetic per-resource key (their
      // real publicPath is shared); route matching must use that same key. The 402
      // challenge still advertises the real request URL via adapter.getUrl().
      path: resource.match ? toPaymentRoutePath(resource) : req.path,
      method: req.method,
    };
    const paymentHeader = adapter.getHeader("payment-signature") ?? adapter.getHeader("x-payment");
    if (paymentHeader) {
      context.paymentHeader = paymentHeader;
    }

    const result = await httpServer.processHTTPRequest(context, this.paywallConfig);
    if (result.type === "no-payment-required") {
      // The route exists in this generation, so this is a protected-request hook
      // granting access (e.g. a paywall session): proceed without settlement.
      return { kind: "granted" };
    }
    if (result.type === "payment-error") {
      await this.recordEvent(
        createAccessEvent({
          resourceId: resource.id,
          kind: "challenge",
          requestMethod: req.method,
          requestPath: req.path,
          network: resource.pricing.network,
          payTo: resource.pricing.payTo,
          amount: resource.pricing.amount,
          statusCode: result.response.status,
        }),
      );
      sendPaymentError(res, result);
      return { kind: "responded" };
    }

    const verifiedEvent = createAccessEvent({
      resourceId: resource.id,
      kind: "verified",
      requestMethod: req.method,
      requestPath: req.path,
      network: resource.pricing.network,
      payTo: resource.pricing.payTo,
      amount: resource.pricing.amount,
    });
    const payer = getPayer(result);
    if (payer) {
      verifiedEvent.payer = payer;
    }
    await this.recordEvent(verifiedEvent);
    return { kind: "verified", payment: result };
  }

  private async settlePayment(
    req: Request,
    res: Response,
    resource: X402Resource,
    payment: PaymentVerifiedResult,
  ): Promise<boolean> {
    const httpServer = this.httpServer;
    if (!httpServer) {
      return false;
    }

    const settleResult = await httpServer.processSettlement(
      payment.paymentPayload,
      payment.paymentRequirements as PaymentRequirements,
      payment.declaredExtensions,
    );
    if (!settleResult.success) {
      await this.recordEvent(
        createAccessEvent({
          resourceId: resource.id,
          kind: "settlement_failed",
          requestMethod: req.method,
          requestPath: req.path,
          network: resource.pricing.network,
          payTo: resource.pricing.payTo,
          amount: resource.pricing.amount,
          statusCode: 402,
          errorCode: settleResult.errorReason,
        }),
      );
      res.status(402).json({ error: "Settlement failed", details: settleResult.errorReason });
      return false;
    }

    applySettlementHeaders(res, settleResult);
    const settledEvent = createAccessEvent({
      resourceId: resource.id,
      kind: "settled",
      requestMethod: req.method,
      requestPath: req.path,
      network: resource.pricing.network,
      payTo: resource.pricing.payTo,
      amount: resource.pricing.amount,
      statusCode: 200,
    });
    const payer = getPayer(payment);
    const transaction = getTransaction(settleResult);
    if (payer) {
      settledEvent.payer = payer;
    }
    if (transaction) {
      settledEvent.transaction = transaction;
    }
    await this.recordEvent(settledEvent);
    return true;
  }

  private findPublicResource(req: Request, method: string, path: string): { resource: X402Resource; match: RouteMatch } | null {
    const candidates = this.loaded.filter((item) => item.resource.method === method.toUpperCase());
    // Body-discriminated resources take precedence: among those whose discriminator
    // matches the parsed request body, pick the best path match as usual.
    const bodyMatched = candidates.filter(
      (item) => item.resource.match !== undefined && matchesRequestBody(req, item.resource.match),
    );
    const discriminated = findBestRouteMatch(bodyMatched, path);
    if (discriminated) {
      return { resource: discriminated.candidate.resource, match: discriminated.match };
    }
    // Then unconditional (path-only) resources. A path whose only claimants are
    // body-discriminated resources with non-matching bodies falls through to the host
    // app entirely — e.g. an unknown model on a shared OpenAI-compatible endpoint.
    const unconditional = candidates.filter((item) => item.resource.match === undefined);
    const result = findBestRouteMatch(unconditional, path);
    return result ? { resource: result.candidate.resource, match: result.match } : null;
  }

  private findLeaseResource(method: string, path: string): { resource: X402Resource; match: RouteMatch } | null {
    if (method.toUpperCase() !== "POST") {
      return null;
    }
    const candidates = this.loaded
      .filter((item): item is LoadedResourceInternal & { leasePattern: CompiledRoutePattern } => Boolean(item.leasePattern))
      .map((item) => ({ ...item, routePattern: item.leasePattern }));
    const result = findBestRouteMatch(candidates, path);
    return result ? { resource: result.candidate.resource, match: result.match } : null;
  }

  private async handleHttp(req: Request, res: Response, resource: X402Resource, match: RouteMatch): Promise<void> {
    const outcome = await this.processPayment(req, res, resource);
    if (outcome.kind === "responded") {
      return;
    }
    const proxyInput: Parameters<typeof proxyBufferedHttpRequest>[0] = {
      target: {
        id: resource.id,
        method: resource.method,
        upstreamUrl: resource.upstreamUrl,
        ...(resource.headers ? { headers: resource.headers } : {}),
        ...(resource.access ? { access: resource.access } : {}),
      },
      req,
      res,
      params: match.params,
    };
    if (this.security) {
      proxyInput.securityConfig = this.security;
    }
    const upstreamResult = await proxyBufferedHttpRequest(proxyInput);
    if (outcome.kind === "verified" && upstreamResult.status < 400) {
      const settled = await this.settlePayment(req, res, resource, outcome.payment);
      if (!settled) {
        return;
      }
    }
    await sendBufferedProxyResponse(res, upstreamResult, resource.headers);
  }

  /**
   * Single-request paid streaming: verify, settle, then pipe the upstream response
   * unbuffered. Settlement completes BEFORE the upstream call (pay-for-access), so the
   * PAYMENT-RESPONSE header is set before any bytes stream. Both SSE and buffered JSON
   * upstream responses relay through the same pipe.
   */
  private async handleHttpStreamDirect(req: Request, res: Response, resource: X402Resource, match: RouteMatch): Promise<void> {
    const outcome = await this.processPayment(req, res, resource);
    if (outcome.kind === "responded") {
      return;
    }
    if (outcome.kind === "verified") {
      const settled = await this.settlePayment(req, res, resource, outcome.payment);
      if (!settled) {
        return;
      }
    }
    const proxyInput: Parameters<typeof proxyStreamingHttpRequest>[0] = {
      target: {
        id: resource.id,
        method: resource.method,
        upstreamUrl: resource.upstreamUrl,
        ...(resource.headers ? { headers: resource.headers } : {}),
        ...(resource.access ? { access: resource.access } : {}),
      },
      req,
      res,
      params: match.params,
    };
    if (this.security) {
      proxyInput.securityConfig = this.security;
    }
    await proxyStreamingHttpRequest(proxyInput);
  }

  private async handleStreamLease(req: Request, res: Response, resource: X402Resource, match: RouteMatch): Promise<void> {
    const outcome = await this.processPayment(req, res, resource);
    if (outcome.kind === "responded") {
      return;
    }

    if (outcome.kind === "verified") {
      const settled = await this.settlePayment(req, res, resource, outcome.payment);
      if (!settled) {
        return;
      }
    }
    const baseUrl = inferRequestBaseUrl(req, this.discovery?.publicBaseUrl);
    if (resource.kind === "websocket") {
      const lease = issueLease(
        {
          id: resource.id,
          wsPath: resource.publicPath as `/${string}`,
          upstreamWsUrl: resource.upstreamUrl,
          leaseSeconds: resource.stream?.leaseSeconds ?? 0,
        },
        this.leaseTokenSecret,
        baseUrl,
      );
      await this.recordEvent(
        createAccessEvent({
          resourceId: resource.id,
          kind: "lease_issued",
          requestMethod: req.method,
          requestPath: req.path,
          network: resource.pricing.network,
          payTo: resource.pricing.payTo,
          amount: resource.pricing.amount,
          statusCode: 200,
        }),
      );
      res.status(200).json(lease);
      return;
    }

    const lease = issueHttpStreamLease(resource, this.leaseTokenSecret, baseUrl, match.params);
    await this.recordEvent(
      createAccessEvent({
        resourceId: resource.id,
        kind: "lease_issued",
        requestMethod: req.method,
        requestPath: req.path,
        network: resource.pricing.network,
        payTo: resource.pricing.payTo,
        amount: resource.pricing.amount,
        statusCode: 200,
      }),
    );
    res.status(200).json(lease);
  }

  private async handleHttpStream(req: Request, res: Response, resource: X402Resource, match: RouteMatch): Promise<void> {
    const token = getLeaseToken(req);
    if (!token) {
      await this.recordEvent(
        createAccessEvent({
          resourceId: resource.id,
          kind: "lease_rejected",
          requestMethod: req.method,
          requestPath: req.path,
          network: resource.pricing.network,
          payTo: resource.pricing.payTo,
          amount: resource.pricing.amount,
          statusCode: 401,
          errorCode: "missing_lease_token",
        }),
      );
      res.status(401).json({ error: "Missing x402 lease token" });
      return;
    }

    let payload;
    try {
      payload = verifyHttpStreamLeaseToken(token, this.leaseTokenSecret, {
        resourceId: resource.id,
        method: resource.method,
        publicPath: resource.publicPath,
        upstreamUrl: resource.upstreamUrl,
      });
      const consumed = await this.leaseUseStore.consume(payload.jti, payload.exp);
      if (!consumed) {
        throw new LeaseTokenError("Lease token already used");
      }
    } catch (error: unknown) {
      await this.recordEvent(
        createAccessEvent({
          resourceId: resource.id,
          kind: "lease_rejected",
          requestMethod: req.method,
          requestPath: req.path,
          network: resource.pricing.network,
          payTo: resource.pricing.payTo,
          amount: resource.pricing.amount,
          statusCode: 401,
          errorCode: error instanceof Error ? error.message : "invalid_lease_token",
        }),
      );
      res.status(401).json({ error: "Invalid x402 lease token" });
      return;
    }

    const proxyInput: Parameters<typeof proxyStreamingHttpRequest>[0] = {
      target: {
        id: resource.id,
        method: resource.method,
        upstreamUrl: resource.upstreamUrl,
        ...(resource.headers ? { headers: resource.headers } : {}),
        ...(resource.access ? { access: resource.access } : {}),
      },
      req,
      res,
      params: match.params,
      excludeQueryParams: ["t"],
    };
    if (this.security) {
      proxyInput.securityConfig = this.security;
    }
    await proxyStreamingHttpRequest(proxyInput);
  }

  public middleware(): RequestHandler {
    return async (req, res, next) => {
      try {
        await this.ensureLoaded();
        const leaseResource = this.findLeaseResource(req.method, req.path);
        if (leaseResource) {
          await this.handleStreamLease(req, res, leaseResource.resource, leaseResource.match);
          return;
        }

        const publicResource = this.findPublicResource(req, req.method, req.path);
        if (!publicResource) {
          next();
          return;
        }

        if (publicResource.resource.kind === "http") {
          await this.handleHttp(req, res, publicResource.resource, publicResource.match);
          return;
        }
        if (publicResource.resource.kind === "http-stream-direct") {
          await this.handleHttpStreamDirect(req, res, publicResource.resource, publicResource.match);
          return;
        }
        if (publicResource.resource.kind === "http-stream") {
          await this.handleHttpStream(req, res, publicResource.resource, publicResource.match);
          return;
        }
        if (publicResource.resource.kind === "websocket") {
          res.status(426).json({ error: "Upgrade Required: connect via WebSocket with lease token" });
          return;
        }
        next();
      } catch (error: unknown) {
        sendProxyErrorResponse(res, error);
      }
    };
  }

  public install(app: Express): void {
    app.use(this.middleware());
    app.get("/x402/diagnostics", (_req, res) => {
      res.status(200).json(this.diagnostics());
    });
  }
}

export function endpointToResource(endpoint: ProxyEndpointConfig, defaults: { network: Network; payTo: string }): X402Resource {
  const network = endpoint.network ?? defaults.network;
  const payTo = endpoint.payTo ?? defaults.payTo;
  const now = Date.now();

  if (isHttpEndpoint(endpoint)) {
    const pricing: X402Resource["pricing"] = {
      amount: endpoint.price,
      network,
      payTo,
    };
    if (endpoint.currency?.asset !== undefined) {
      pricing.asset = endpoint.currency.asset;
    }
    if (endpoint.currency?.decimals !== undefined) {
      pricing.decimals = endpoint.currency.decimals;
    }
    const resource: X402Resource = {
      id: endpoint.id,
      enabled: true,
      kind: "http",
      publicPath: endpoint.publicPath,
      upstreamUrl: endpoint.upstreamUrl,
      method: endpoint.method,
      pricing,
      access: { mode: "pass-through" },
      createdAt: now,
      updatedAt: now,
    };
    if (endpoint.headers) {
      resource.headers = endpoint.headers;
    }
    return resource;
  }

  if (isWebSocketEndpoint(endpoint)) {
    const pricing: X402Resource["pricing"] = {
      amount: endpoint.price,
      network,
      payTo,
    };
    if (endpoint.currency?.asset !== undefined) {
      pricing.asset = endpoint.currency.asset;
    }
    if (endpoint.currency?.decimals !== undefined) {
      pricing.decimals = endpoint.currency.decimals;
    }
    return {
      id: endpoint.id,
      enabled: true,
      kind: "websocket",
      publicPath: endpoint.wsPath,
      upstreamUrl: endpoint.upstreamWsUrl,
      method: "GET",
      pricing,
      access: { mode: "pass-through" },
      stream: {
        leasePath: endpoint.leasePath,
        leaseSeconds: endpoint.leaseSeconds,
        allowRenewal: false,
        renewalWindowSeconds: 0,
      },
      createdAt: now,
      updatedAt: now,
    };
  }

  throw new RouteBuildError("Unsupported endpoint kind");
}
