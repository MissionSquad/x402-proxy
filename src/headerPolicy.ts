import type { Request, Response } from "express";

import type { X402HeaderPolicy, X402HeaderPreset, X402ResourceAccess } from "./types";

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
  "x-x402-lease",
]);

/**
 * Preset request-header allowlists. These match the x402-proxy expansion spec exactly;
 * anything beyond them (x-request-id, idempotency-key, webhook secrets, ...) must be
 * opted into per resource via `forwardRequestHeaders`.
 */
const REQUEST_PRESET_HEADERS: Record<X402HeaderPreset, string[]> = {
  none: [],
  "api-auth": [
    "authorization",
    "x-api-key",
    "content-type",
    "accept",
    "user-agent",
    "x-client-id",
    "x-session-id",
  ],
  "browser-auth": [
    "cookie",
    "authorization",
    "content-type",
    "accept",
    "user-agent",
    "x-client-id",
    "x-session-id",
  ],
  streaming: [],
};

/**
 * Response headers forwarded for every proxied response regardless of preset.
 *
 * Without these, a buffered (non-streaming) HTTP resource would forward zero upstream
 * response headers, dropping Content-Type and breaking generic REST clients. Hop-by-hop,
 * payment, content-length and content-encoding headers are intentionally excluded because
 * the proxy re-frames the body (fetch transparently decompresses upstream bodies, so a
 * forwarded Content-Encoding would describe bytes that are no longer encoded).
 */
const DEFAULT_RESPONSE_HEADERS = new Set([
  "content-type",
  "content-disposition",
  "content-language",
  "content-range",
  "accept-ranges",
  "cache-control",
  "etag",
  "last-modified",
  "expires",
  "vary",
  "location",
  "retry-after",
  "www-authenticate",
]);

/**
 * Response headers the proxy manages itself and must never copy verbatim from upstream,
 * because the response body is re-encoded/re-buffered (length and encoding would be wrong).
 */
const MANAGED_RESPONSE_HEADERS = new Set(["content-encoding", "content-length"]);

const RESPONSE_PRESET_HEADERS: Record<X402HeaderPreset, string[]> = {
  none: [],
  "api-auth": [],
  "browser-auth": [],
  streaming: ["content-type", "cache-control", "connection", "x-accel-buffering", "x-run-id"],
};

/** RFC 9110 field-name token: no whitespace, separators, or control characters. */
const HEADER_NAME_TOKEN_REGEX = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** CR, LF, and NUL in a field value enable header injection and make Headers.set throw. */
const HEADER_VALUE_FORBIDDEN_REGEX = /[\r\n\0]/;

export function isValidHttpHeaderName(name: string): boolean {
  return HEADER_NAME_TOKEN_REGEX.test(name);
}

export function isValidHttpHeaderValue(value: string): boolean {
  return !HEADER_VALUE_FORBIDDEN_REGEX.test(value);
}

export function shouldDropProxyHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    HOP_BY_HOP_HEADERS.has(lower) ||
    INTERNAL_PAYMENT_HEADERS.has(lower) ||
    lower === "host" ||
    lower === "content-length"
  );
}

function normalizeHeaderList(values?: string[]): Set<string> {
  return new Set((values ?? []).map((value) => value.toLowerCase()));
}

function collectPresetHeaders(
  presets: X402HeaderPreset[] | undefined,
  table: Record<X402HeaderPreset, string[]>,
): Set<string> {
  const allowed = new Set<string>();
  for (const preset of presets ?? ["none"]) {
    for (const header of table[preset]) {
      allowed.add(header);
    }
  }
  return allowed;
}

export function createForwardHeaders(req: Request, policy?: X402HeaderPolicy): Headers {
  const allowed = collectPresetHeaders(policy?.presets, REQUEST_PRESET_HEADERS);
  for (const header of normalizeHeaderList(policy?.forwardRequestHeaders)) {
    allowed.add(header);
  }
  const excluded = normalizeHeaderList(policy?.excludeRequestHeaders);

  const headers = new Headers();
  for (const [headerName, headerValue] of Object.entries(req.headers)) {
    const lower = headerName.toLowerCase();
    if (!allowed.has(lower) || excluded.has(lower) || shouldDropProxyHeader(lower)) {
      continue;
    }
    if (headerValue === undefined) {
      continue;
    }
    headers.set(lower, Array.isArray(headerValue) ? headerValue.join(", ") : headerValue);
  }

  for (const [headerName, headerValue] of Object.entries(policy?.addRequestHeaders ?? {})) {
    const lower = headerName.toLowerCase();
    if (shouldDropProxyHeader(lower)) {
      continue;
    }
    headers.set(headerName, headerValue);
  }

  return headers;
}

export function applyUpstreamResponseHeaders(
  res: Response,
  upstreamResponse: globalThis.Response,
  policy?: X402HeaderPolicy,
): void {
  const allowed = collectPresetHeaders(policy?.presets, RESPONSE_PRESET_HEADERS);
  for (const header of DEFAULT_RESPONSE_HEADERS) {
    allowed.add(header);
  }
  for (const header of normalizeHeaderList(policy?.forwardResponseHeaders)) {
    allowed.add(header);
  }
  const excluded = normalizeHeaderList(policy?.excludeResponseHeaders);

  for (const [headerName, headerValue] of upstreamResponse.headers.entries()) {
    const lower = headerName.toLowerCase();
    if (MANAGED_RESPONSE_HEADERS.has(lower)) {
      continue;
    }
    if (!allowed.has(lower) || excluded.has(lower) || shouldDropProxyHeader(lower)) {
      continue;
    }
    res.setHeader(headerName, headerValue);
  }

  for (const [headerName, headerValue] of Object.entries(policy?.addResponseHeaders ?? {})) {
    if (shouldDropProxyHeader(headerName.toLowerCase())) {
      continue;
    }
    res.setHeader(headerName, headerValue);
  }
}

/**
 * Apply a resource's `service-token` access mode to the outbound upstream headers,
 * replacing any client-supplied value for the same header. Runs after the header
 * policy so the injected credential always wins. Payment/hop-by-hop names, invalid
 * header-name tokens, and values containing CR/LF/NUL are refused here as defense in
 * depth (a custom resource store may bypass validateX402Resource; an invalid name or
 * value would otherwise throw in Headers.set or enable header injection).
 */
export function applyServiceTokenAccess(headers: Headers, access?: X402ResourceAccess): void {
  if (access?.mode !== "service-token") {
    return;
  }
  const { serviceTokenHeader, serviceTokenValue } = access;
  if (
    !serviceTokenHeader ||
    !serviceTokenValue ||
    !isValidHttpHeaderName(serviceTokenHeader) ||
    !isValidHttpHeaderValue(serviceTokenValue) ||
    shouldDropProxyHeader(serviceTokenHeader.toLowerCase())
  ) {
    return;
  }
  headers.set(serviceTokenHeader, serviceTokenValue);
}
