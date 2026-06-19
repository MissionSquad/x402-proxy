import { ExpressAdapter } from "@x402/express";
import { x402HTTPResourceServer, type HTTPProcessResult, type RouteConfig } from "@x402/core/server";
import type { PaymentRequirements, PaymentPayload, Network } from "@x402/core/types";
import type { Express, Request, RequestHandler, Response } from "express";

import { resolvePrice } from "./currency";
import { LeaseTokenError, RouteBuildError, SecurityPolicyError, UpstreamRequestError, UpstreamTimeoutError } from "./errors";
import {
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
  X402AccessEventStore,
  X402LoadedResource,
  X402ProxyDiagnostics,
  X402Resource,
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
};

type PaymentVerifiedResult = Extract<HTTPProcessResult, { type: "payment-verified" }>;

function toPaymentPath(resource: X402Resource): string {
  if (resource.kind === "http") {
    return resource.publicPath;
  }
  if (!resource.stream) {
    throw new RouteBuildError("Stream resource is missing lease config", { resourceId: resource.id });
  }
  return resource.stream.leasePath;
}

function toPaymentMethod(resource: X402Resource): HttpMethod | "POST" {
  return resource.kind === "http" ? resource.method : "POST";
}

function toRouteDescription(resource: X402Resource): string {
  if (resource.kind === "http") {
    return `Paid HTTP access for ${resource.id}`;
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
  return {
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

  private loaded: LoadedResourceInternal[] = [];

  private invalid: X402ResourceValidationIssue[] = [];

  private lastRefreshAt: number | undefined;

  private httpServer: x402HTTPResourceServer | null = null;

  private initPromise: Promise<void> | null = null;

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
    if (options.initialResources) {
      this.loadResources(options.initialResources, Date.now());
    }
  }

  private loadResources(resources: X402Resource[], refreshedAt: number): X402ResourceRefreshResult {
    const invalid: X402ResourceValidationIssue[] = [];
    const seenPaymentRoutes = new Set<string>();
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
        const paymentRoute = `${toPaymentMethod(resource)} ${toPaymentPath(resource)}`;
        if (seenPaymentRoutes.has(paymentRoute)) {
          invalid.push({ resourceId: resource.id, reason: `duplicate payment route ${paymentRoute}` });
          continue;
        }
        seenPaymentRoutes.add(paymentRoute);
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
    this.httpServer = new x402HTTPResourceServer(this.resourceServer, routes);
    this.initPromise = this.syncFacilitatorOnStart ? this.httpServer.initialize() : null;

    return {
      loaded: loaded.map((item) => toLoadedResource(item.resource)),
      invalid,
      refreshedAt,
    };
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
    return diagnostics;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.httpServer) {
      return;
    }
    await this.refreshResources();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
      this.initPromise = null;
    }
  }

  private async processPayment(req: Request, res: Response, resource: X402Resource): Promise<PaymentVerifiedResult | null> {
    await this.ensureLoaded();
    const httpServer = this.httpServer;
    if (!httpServer) {
      return null;
    }

    const adapter = new ExpressAdapter(req);
    const context: {
      adapter: ExpressAdapter;
      path: string;
      method: string;
      paymentHeader?: string;
    } = {
      adapter,
      path: req.path,
      method: req.method,
    };
    const paymentHeader = adapter.getHeader("payment-signature") ?? adapter.getHeader("x-payment");
    if (paymentHeader) {
      context.paymentHeader = paymentHeader;
    }

    await this.ensureInitialized();
    const result = await httpServer.processHTTPRequest(context);
    if (result.type === "no-payment-required") {
      return null;
    }
    if (result.type === "payment-error") {
      await this.eventStore.record(
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
      return null;
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
    await this.eventStore.record(verifiedEvent);
    return result;
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
      await this.eventStore.record(
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
    await this.eventStore.record(settledEvent);
    return true;
  }

  private findPublicResource(method: string, path: string): { resource: X402Resource; match: RouteMatch } | null {
    const candidates = this.loaded
      .filter((item) => item.resource.method === method.toUpperCase())
      .map((item) => ({ ...item, routePattern: item.routePattern }));
    const result = findBestRouteMatch(candidates, path);
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
    const payment = await this.processPayment(req, res, resource);
    if (!payment) {
      return;
    }
    const proxyInput: Parameters<typeof proxyBufferedHttpRequest>[0] = {
      target: {
        id: resource.id,
        method: resource.method,
        upstreamUrl: resource.upstreamUrl,
        ...(resource.headers ? { headers: resource.headers } : {}),
      },
      req,
      res,
      params: match.params,
    };
    if (this.security) {
      proxyInput.securityConfig = this.security;
    }
    const upstreamResult = await proxyBufferedHttpRequest(proxyInput);
    if (upstreamResult.status < 400) {
      const settled = await this.settlePayment(req, res, resource, payment);
      if (!settled) {
        return;
      }
    }
    await sendBufferedProxyResponse(res, upstreamResult, resource.headers);
  }

  private async handleStreamLease(req: Request, res: Response, resource: X402Resource, match: RouteMatch): Promise<void> {
    const payment = await this.processPayment(req, res, resource);
    if (!payment) {
      return;
    }

    const settled = await this.settlePayment(req, res, resource, payment);
    if (!settled) {
      return;
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
      await this.eventStore.record(
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
    await this.eventStore.record(
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
      await this.eventStore.record(
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
      await this.eventStore.record(
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

        const publicResource = this.findPublicResource(req.method, req.path);
        if (!publicResource) {
          next();
          return;
        }

        if (publicResource.resource.kind === "http") {
          await this.handleHttp(req, res, publicResource.resource, publicResource.match);
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
        if (error instanceof SecurityPolicyError) {
          res.status(403).json({ error: error.message, code: error.code });
          return;
        }
        if (error instanceof Error && error.name === "AbortError") {
          res.status(504).json({ error: "Upstream request timed out", code: "UPSTREAM_TIMEOUT_ERROR" });
          return;
        }
        if (error instanceof UpstreamRequestError || error instanceof UpstreamTimeoutError || error instanceof LeaseTokenError) {
          res.status(502).json({ error: error.message, code: error.code });
          return;
        }
        next(error);
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
