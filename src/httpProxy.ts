import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import type { Request, RequestHandler, Response } from "express";

import {
  RequestBodyTooLargeError,
  SecurityPolicyError,
  UpstreamRequestError,
  UpstreamTimeoutError,
} from "./errors";
import {
  applyPaymentMetadataHeaders,
  applyServiceTokenAccess,
  applyUpstreamResponseHeaders,
  createForwardHeaders,
} from "./headerPolicy";
import { interpolateUpstreamUrl } from "./routePattern";
import type {
  HttpMethod,
  HttpProxyEndpointConfig,
  SecurityConfig,
  X402HeaderPolicy,
  X402PaymentMetadata,
  X402ResourceAccess,
} from "./types";

const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export type EffectiveSecurityPolicy = {
  allowInsecureHttpUpstream: boolean;
  allowPrivateIpUpstreams: boolean;
  upstreamTimeoutMs?: number;
  maxRequestBodyBytes?: number;
};

function toEffectiveSecurityPolicy(security?: SecurityConfig): EffectiveSecurityPolicy {
  const policy: EffectiveSecurityPolicy = {
    allowInsecureHttpUpstream: security?.allowInsecureHttpUpstream ?? false,
    allowPrivateIpUpstreams: security?.allowPrivateIpUpstreams ?? false,
  };
  if (security?.upstreamTimeoutMs !== undefined) {
    policy.upstreamTimeoutMs = security.upstreamTimeoutMs;
  }
  if (security?.maxRequestBodyBytes !== undefined) {
    policy.maxRequestBodyBytes = security.maxRequestBodyBytes;
  }
  return policy;
}

/**
 * Strip surrounding IPv6 brackets and any zone identifier so the address can be
 * classified. `URL.hostname` returns IPv6 literals as "[::1]" (with brackets), which
 * `net.isIP` does not recognize.
 */
function normalizeIpLiteral(host: string): string {
  let value = host;
  if (value.startsWith("[") && value.endsWith("]")) {
    value = value.slice(1, -1);
  }
  const zoneIndex = value.indexOf("%");
  if (zoneIndex !== -1) {
    value = value.slice(0, zoneIndex);
  }
  return value;
}

/**
 * Extract the embedded IPv4 address from an IPv4-mapped IPv6 address (::ffff:a.b.c.d
 * dotted, ::ffff:hhhh:hhhh hex) or a deprecated IPv4-compatible address (::a.b.c.d).
 * Node normalizes ::ffff:127.0.0.1 to the hex form ::ffff:7f00:1, so both must be handled.
 */
function extractEmbeddedIpv4(normalized: string): string | null {
  const dotted = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(normalized);
  if (dotted && dotted[1]) {
    return dotted[1];
  }
  const hex = /^::ffff:([0-9a-f]{1,4})(?::([0-9a-f]{1,4}))?$/.exec(normalized);
  if (hex && hex[1]) {
    const high = hex[2] !== undefined ? Number.parseInt(hex[1], 16) : 0;
    const low = hex[2] !== undefined ? Number.parseInt(hex[2], 16) : Number.parseInt(hex[1], 16);
    return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
  }
  return null;
}

function isPrivateOrLoopbackIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const parts = address.split(".").map((part) => Number.parseInt(part, 10));
    if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
      return true;
    }
    const a = parts[0];
    const b = parts[1];
    if (a === undefined || b === undefined) {
      return true;
    }
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }

  if (family === 6) {
    const normalized = normalizeIpLiteral(address.toLowerCase());
    if (normalized === "::" || normalized === "::1") return true;
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
    // Link-local fe80::/10 and deprecated site-local fec0::/10.
    if (/^fe[89abcdef]/.test(normalized)) return true;
    // NAT64 well-known prefix 64:ff9b::/96 (reaches IPv4 hosts on NAT64 networks).
    if (normalized.startsWith("64:ff9b:") || normalized.startsWith("64:ff9b::")) return true;
    const embedded = extractEmbeddedIpv4(normalized);
    if (embedded !== null) {
      return isPrivateOrLoopbackIp(embedded);
    }
    return false;
  }

  return true;
}

export async function assertUpstreamAllowed(url: URL, security: EffectiveSecurityPolicy): Promise<void> {
  if (url.protocol === "http:" && !security.allowInsecureHttpUpstream) {
    throw new SecurityPolicyError("Insecure HTTP upstreams are disabled", { upstreamUrl: url.toString() });
  }

  if (!security.allowPrivateIpUpstreams) {
    const hostname = normalizeIpLiteral(url.hostname);
    if (hostname.toLowerCase() === "localhost") {
      throw new SecurityPolicyError("Private/loopback upstreams are disabled", { hostname });
    }

    if (isIP(hostname) !== 0) {
      if (isPrivateOrLoopbackIp(hostname)) {
        throw new SecurityPolicyError("Private/loopback upstreams are disabled", { hostname });
      }
      return;
    }

    const resolved = await lookup(hostname, { all: true, verbatim: true });
    if (resolved.length === 0) {
      throw new UpstreamRequestError("Unable to resolve upstream hostname", { hostname });
    }

    for (const entry of resolved) {
      if (isPrivateOrLoopbackIp(entry.address)) {
        throw new SecurityPolicyError("Private/loopback upstreams are disabled", {
          hostname,
          resolvedAddress: entry.address,
        });
      }
    }
  }
}

function createTargetUrl(endpoint: HttpProxyEndpointConfig, req: Request): URL {
  const target = new URL(endpoint.upstreamUrl);
  const incoming = new URL(req.originalUrl, "http://localhost");
  for (const [key, value] of incoming.searchParams.entries()) {
    target.searchParams.append(key, value);
  }
  return target;
}

export type HttpProxyResourceTarget = {
  id: string;
  method: HttpMethod;
  upstreamUrl: string;
  headers?: X402HeaderPolicy;
  access?: X402ResourceAccess;
  maxTimeoutSeconds?: number;
};

export type ProxyHttpRequestInput = {
  target: HttpProxyResourceTarget;
  req: Request;
  res: Response;
  securityConfig?: SecurityConfig;
  params?: Record<string, string>;
  excludeQueryParams?: string[];
  /**
   * Trusted payment metadata to inject as `x-x402-*` headers on the upstream request
   * (after the header policy and service-token injection, so it always wins). Client
   * values for these names are stripped by the header policy regardless.
   */
  paymentMetadata?: X402PaymentMetadata;
};

export type BufferedProxyResponse = {
  status: number;
  response: globalThis.Response;
  body: Buffer;
};

function getContentType(req: Request): string {
  const value = req.headers["content-type"];
  return typeof value === "string" ? value.toLowerCase() : "";
}

/**
 * Re-serialize a body already parsed by an upstream body parser. Raw buffers/strings pass
 * through verbatim; parsed objects are encoded to match the request's Content-Type so that
 * urlencoded forms are not silently corrupted into JSON.
 */
function serializeBodyFromParsedBody(parsedBody: unknown, req: Request): Uint8Array | string {
  if (Buffer.isBuffer(parsedBody)) {
    return new Uint8Array(parsedBody);
  }
  if (typeof parsedBody === "string") {
    return parsedBody;
  }
  if (parsedBody instanceof Uint8Array) {
    return parsedBody;
  }
  if (getContentType(req).includes("application/x-www-form-urlencoded")) {
    return new URLSearchParams(parsedBody as Record<string, string>).toString();
  }
  return new TextEncoder().encode(JSON.stringify(parsedBody));
}

async function readRequestBody(
  req: Request,
  maxBytes?: number,
): Promise<Uint8Array | string | undefined> {
  if (!BODY_METHODS.has(req.method.toUpperCase())) {
    return undefined;
  }

  if (req.body !== undefined) {
    return serializeBodyFromParsedBody(req.body, req);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (maxBytes !== undefined && total > maxBytes) {
      throw new RequestBodyTooLargeError("Request body exceeds the configured maximum size", {
        maxRequestBodyBytes: maxBytes,
      });
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return undefined;
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function resolveTimeoutMs(endpoint: Pick<HttpProxyResourceTarget, "maxTimeoutSeconds">, security: EffectiveSecurityPolicy): number {
  if (security.upstreamTimeoutMs && security.upstreamTimeoutMs > 0) {
    return security.upstreamTimeoutMs;
  }
  if (endpoint.maxTimeoutSeconds && endpoint.maxTimeoutSeconds > 0) {
    return endpoint.maxTimeoutSeconds * 1000;
  }
  return 30_000;
}

function createInterpolatedTargetUrl(
  target: Pick<HttpProxyResourceTarget, "upstreamUrl">,
  req: Request,
  params: Record<string, string> = {},
  excludeQueryParams: string[] = [],
): URL {
  return interpolateUpstreamUrl(
    target.upstreamUrl,
    params,
    req.originalUrl,
    new Set(excludeQueryParams.map((value) => value.toLowerCase())),
  );
}

/**
 * Shape-based AbortError check: undici rejects aborted fetches/reads with a DOMException
 * named "AbortError", which is not an `instanceof Error` on every Node version.
 */
export function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

function toAbortErrorResponse(targetId: string): UpstreamTimeoutError {
  return new UpstreamTimeoutError("Upstream request timed out", {
    endpointId: targetId,
  });
}

export async function proxyBufferedHttpRequest(input: ProxyHttpRequestInput): Promise<BufferedProxyResponse> {
  const security = toEffectiveSecurityPolicy(input.securityConfig);
  const targetUrl = createInterpolatedTargetUrl(
    input.target,
    input.req,
    input.params,
    input.excludeQueryParams,
  );
  await assertUpstreamAllowed(targetUrl, security);

  const body = await readRequestBody(input.req, security.maxRequestBodyBytes);
  const timeoutMs = resolveTimeoutMs(input.target, security);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const headers = createForwardHeaders(input.req, input.target.headers);
  applyServiceTokenAccess(headers, input.target.access);
  if (input.paymentMetadata) {
    applyPaymentMetadataHeaders(headers, input.paymentMetadata);
  }
  const requestInit: RequestInit = {
    method: input.req.method,
    headers,
    signal: controller.signal,
    redirect: "manual",
  };
  if (body !== undefined) {
    requestInit.body = body as unknown as BodyInit;
  }

  let response: globalThis.Response;
  try {
    response = await fetch(targetUrl, requestInit);
  } finally {
    clearTimeout(timeout);
  }

  const responseBuffer = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    response,
    body: responseBuffer,
  };
}

export async function sendBufferedProxyResponse(
  res: Response,
  result: BufferedProxyResponse,
  policy?: X402HeaderPolicy,
): Promise<void> {
  applyUpstreamResponseHeaders(res, result.response, policy);
  res.status(result.status);
  res.send(result.body);
}

/**
 * An upstream streaming connection whose response headers have arrived but whose body
 * has not been relayed yet. Lets callers act between connection and relay — e.g. settle
 * an x402 payment only after the upstream accepted the request (status < 400) and
 * before any body bytes reach the client.
 */
export type StreamingUpstreamConnection = {
  response: globalThis.Response;
  /** Write status + policy-filtered headers to the client and pipe the body with backpressure and disconnect propagation. */
  relay: () => Promise<void>;
  /** Cancel the upstream request without relaying (e.g. settlement failed after connect). */
  abort: () => void;
};

/**
 * Connect to the streaming upstream. Resolves once response headers arrive; resolves
 * `null` when the client disconnected during connection establishment (nothing to send).
 *
 * @throws SecurityPolicyError / UpstreamTimeoutError / fetch errors on real failures.
 */
export async function openStreamingUpstream(input: ProxyHttpRequestInput): Promise<StreamingUpstreamConnection | null> {
  const security = toEffectiveSecurityPolicy(input.securityConfig);
  const targetUrl = createInterpolatedTargetUrl(
    input.target,
    input.req,
    input.params,
    input.excludeQueryParams,
  );
  await assertUpstreamAllowed(targetUrl, security);

  const body = await readRequestBody(input.req, security.maxRequestBodyBytes);
  const timeoutMs = resolveTimeoutMs(input.target, security);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let clientClosed = false;
  const abortForClientDisconnect = (): void => {
    clientClosed = true;
    controller.abort();
  };
  // In Node 20+, a server IncomingMessage does not reliably emit "close" when the client
  // aborts mid-response; the response's "close" (fired on premature connection termination)
  // is the dependable signal. Keep the request listener for request-side terminations and
  // guard on writableEnded so a naturally completed response never aborts anything.
  input.req.on("close", abortForClientDisconnect);
  input.res.on("close", () => {
    if (!input.res.writableEnded) {
      abortForClientDisconnect();
    }
  });

  const headers = createForwardHeaders(input.req, input.target.headers);
  applyServiceTokenAccess(headers, input.target.access);
  if (input.paymentMetadata) {
    applyPaymentMetadataHeaders(headers, input.paymentMetadata);
  }
  const requestInit: RequestInit = {
    method: input.req.method,
    headers,
    signal: controller.signal,
    redirect: "manual",
  };
  if (body !== undefined) {
    requestInit.body = body as unknown as BodyInit;
  }

  let response: globalThis.Response;
  try {
    response = await fetch(targetUrl, requestInit);
  } catch (error: unknown) {
    // A client disconnect aborts the shared controller; there is nothing left to send.
    // Swallow only the resulting abort rejection — any other failure is a real error.
    if (clientClosed && isAbortError(error)) {
      return null;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  return {
    response,
    abort: () => {
      controller.abort();
    },
    relay: () => relayStreamingResponse(input, response, controller.signal, () => clientClosed),
  };
}

export async function proxyStreamingHttpRequest(input: ProxyHttpRequestInput): Promise<void> {
  const connection = await openStreamingUpstream(input);
  if (!connection) {
    return;
  }
  await connection.relay();
}

async function relayStreamingResponse(
  input: ProxyHttpRequestInput,
  response: globalThis.Response,
  abortSignal: AbortSignal,
  isClientClosed: () => boolean,
): Promise<void> {
  applyUpstreamResponseHeaders(input.res, response, input.target.headers);
  input.res.status(response.status);

  if (!response.body) {
    input.res.end();
    return;
  }

  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (isClientClosed()) {
        break;
      }
      // Honor backpressure: if the client socket buffer is full, wait for it to drain
      // (or for the client to disconnect) before pulling the next upstream chunk. Also
      // wake on the abort signal so the wait can never outlive the upstream request,
      // regardless of what triggered the abort.
      if (!input.res.write(Buffer.from(value)) && !isClientClosed()) {
        await new Promise<void>((resolve) => {
          const settle = (): void => {
            input.res.off("drain", settle);
            input.res.off("close", settle);
            input.req.off("close", settle);
            abortSignal.removeEventListener("abort", settle);
            resolve();
          };
          input.res.once("drain", settle);
          input.res.once("close", settle);
          input.req.once("close", settle);
          abortSignal.addEventListener("abort", settle, { once: true });
        });
      }
    }
    if (!input.res.writableEnded) {
      input.res.end();
    }
  } catch (error: unknown) {
    // Aborting the upstream fetch after a client disconnect rejects the pending read
    // with an AbortError; there is no one left to answer, so swallow only that case.
    // Any other failure is a real relay error and must propagate even if the client
    // is gone, so it stays visible to host-level error handling.
    if (!(isClientClosed() && isAbortError(error))) {
      throw error;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Create a paid HTTP proxy handler for one endpoint.
 *
 * @throws SecurityPolicyError
 * @throws UpstreamTimeoutError
 * @throws UpstreamRequestError
 */
export function createHttpProxyHandler(
  endpoint: HttpProxyEndpointConfig,
  securityConfig?: SecurityConfig,
): RequestHandler {
  const security = toEffectiveSecurityPolicy(securityConfig);

  return async (req, res, next) => {
    try {
      const targetUrl = createTargetUrl(endpoint, req);
      await assertUpstreamAllowed(targetUrl, security);

      const body = await readRequestBody(req, security.maxRequestBodyBytes);
      const timeoutMs = resolveTimeoutMs(endpoint, security);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      const headers = createForwardHeaders(req, endpoint.headers);
      const requestInit: RequestInit = {
        method: req.method,
        headers,
        signal: controller.signal,
        redirect: "manual",
      };
      if (body !== undefined) {
        requestInit.body = body as unknown as BodyInit;
      }

      let response: globalThis.Response;
      try {
        response = await fetch(targetUrl, requestInit);
      } finally {
        clearTimeout(timeout);
      }

      applyUpstreamResponseHeaders(res, response, endpoint.headers);
      const responseBuffer = Buffer.from(await response.arrayBuffer());
      res.status(response.status);
      res.send(responseBuffer);
    } catch (error: unknown) {
      if (error instanceof SecurityPolicyError) {
        res.status(403).json({ error: error.message, code: error.code });
        return;
      }
      if (error instanceof RequestBodyTooLargeError) {
        res.status(413).json({ error: error.message, code: error.code });
        return;
      }
      if (isAbortError(error)) {
        const timeoutError = toAbortErrorResponse(endpoint.id);
        res.status(504).json({ error: timeoutError.message, code: timeoutError.code });
        return;
      }
      if (error instanceof UpstreamRequestError || error instanceof UpstreamTimeoutError) {
        res.status(502).json({ error: error.message, code: error.code });
        return;
      }
      next(
        new UpstreamRequestError("Failed to proxy upstream request", {
          endpointId: endpoint.id,
          cause: error instanceof Error ? error.message : "unknown",
        }),
      );
    }
  };
}
