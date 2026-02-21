import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import type { Request, RequestHandler, Response } from "express";

import { SecurityPolicyError, UpstreamRequestError, UpstreamTimeoutError } from "./errors";
import type { HeaderPolicy, HttpProxyEndpointConfig, SecurityConfig } from "./types";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const INTERNAL_PAYMENT_HEADERS = new Set([
  "payment-signature",
  "payment-required",
  "payment-response",
  "x-payment",
  "x-payment-response",
]);

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

type EffectiveSecurityPolicy = {
  allowInsecureHttpUpstream: boolean;
  allowPrivateIpUpstreams: boolean;
  upstreamTimeoutMs?: number;
};

function toEffectiveSecurityPolicy(security?: SecurityConfig): EffectiveSecurityPolicy {
  const policy: EffectiveSecurityPolicy = {
    allowInsecureHttpUpstream: security?.allowInsecureHttpUpstream ?? false,
    allowPrivateIpUpstreams: security?.allowPrivateIpUpstreams ?? false,
  };
  if (security?.upstreamTimeoutMs !== undefined) {
    policy.upstreamTimeoutMs = security.upstreamTimeoutMs;
  }
  return policy;
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
    const normalized = address.toLowerCase();
    if (normalized === "::1") return true;
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
    if (
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb")
    ) {
      return true;
    }
    if (normalized.startsWith("::ffff:127.")) return true;
    return false;
  }

  return true;
}

async function assertUpstreamAllowed(url: URL, security: EffectiveSecurityPolicy): Promise<void> {
  if (url.protocol === "http:" && !security.allowInsecureHttpUpstream) {
    throw new SecurityPolicyError("Insecure HTTP upstreams are disabled", { upstreamUrl: url.toString() });
  }

  if (!security.allowPrivateIpUpstreams) {
    const hostname = url.hostname;
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

function normalizeHeaderAllowlist(allowlist?: string[]): Set<string> {
  return new Set((allowlist ?? []).map((header) => header.toLowerCase()));
}

function shouldDropHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    HOP_BY_HOP_HEADERS.has(lower) ||
    INTERNAL_PAYMENT_HEADERS.has(lower) ||
    lower === "host" ||
    lower === "content-length"
  );
}

function createForwardHeaders(req: Request, policy?: HeaderPolicy): Headers {
  const allowed = normalizeHeaderAllowlist(policy?.forwardRequestHeaders);
  const headers = new Headers();

  for (const [headerName, headerValue] of Object.entries(req.headers)) {
    const lower = headerName.toLowerCase();
    if (allowed.size === 0 || !allowed.has(lower) || shouldDropHeader(lower)) {
      continue;
    }
    if (headerValue === undefined) {
      continue;
    }
    headers.set(lower, Array.isArray(headerValue) ? headerValue.join(", ") : headerValue);
  }

  for (const [headerName, headerValue] of Object.entries(policy?.addRequestHeaders ?? {})) {
    const lower = headerName.toLowerCase();
    if (shouldDropHeader(lower)) {
      continue;
    }
    headers.set(headerName, headerValue);
  }

  return headers;
}

function applyUpstreamResponseHeaders(res: Response, upstreamResponse: globalThis.Response, policy?: HeaderPolicy): void {
  const allowed = normalizeHeaderAllowlist(policy?.forwardResponseHeaders);
  for (const [headerName, headerValue] of upstreamResponse.headers.entries()) {
    const lower = headerName.toLowerCase();
    if (allowed.size === 0 || !allowed.has(lower) || shouldDropHeader(lower)) {
      continue;
    }
    res.setHeader(headerName, headerValue);
  }

  for (const [headerName, headerValue] of Object.entries(policy?.addResponseHeaders ?? {})) {
    if (shouldDropHeader(headerName.toLowerCase())) {
      continue;
    }
    res.setHeader(headerName, headerValue);
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

function serializeBodyFromParsedBody(parsedBody: unknown): Uint8Array | string {
  if (Buffer.isBuffer(parsedBody)) {
    return new Uint8Array(parsedBody);
  }
  if (typeof parsedBody === "string") {
    return parsedBody;
  }
  if (parsedBody instanceof Uint8Array) {
    return parsedBody;
  }
  return new TextEncoder().encode(JSON.stringify(parsedBody));
}

async function readRequestBody(req: Request): Promise<Uint8Array | string | undefined> {
  if (!BODY_METHODS.has(req.method.toUpperCase())) {
    return undefined;
  }

  if (req.body !== undefined) {
    return serializeBodyFromParsedBody(req.body);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return undefined;
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function resolveTimeoutMs(endpoint: HttpProxyEndpointConfig, security: EffectiveSecurityPolicy): number {
  if (security.upstreamTimeoutMs && security.upstreamTimeoutMs > 0) {
    return security.upstreamTimeoutMs;
  }
  if (endpoint.maxTimeoutSeconds && endpoint.maxTimeoutSeconds > 0) {
    return endpoint.maxTimeoutSeconds * 1000;
  }
  return 30_000;
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

      const body = await readRequestBody(req);
      const timeoutMs = resolveTimeoutMs(endpoint, security);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      const headers = createForwardHeaders(req, endpoint.headers);
      const requestInit: RequestInit = {
        method: req.method,
        headers,
        signal: controller.signal,
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
      if (error instanceof Error && error.name === "AbortError") {
        const timeoutError = new UpstreamTimeoutError("Upstream request timed out", {
          endpointId: endpoint.id,
        });
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
