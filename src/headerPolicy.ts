import type { Request, Response } from "express";

import type { X402HeaderPolicy, X402HeaderPreset, X402PaymentMetadata, X402ResourceAccess } from "./types";

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

/**
 * SDK-minted payment-metadata header names, keyed by `X402PaymentMetadata` field. All
 * nine are registered as internal payment headers, so client-supplied values can never
 * reach the upstream (not even via a resource's `forwardRequestHeaders` allowlist) —
 * an upstream can therefore trust that any value it sees was injected by the proxy via
 * `applyPaymentMetadataHeaders`.
 */
export const PAYMENT_METADATA_HEADERS = {
  paymentId: "x-x402-payment-id",
  resourceId: "x-x402-resource-id",
  scheme: "x-x402-scheme",
  network: "x-x402-network",
  amount: "x-x402-amount",
  asset: "x-x402-asset",
  payTo: "x-x402-pay-to",
  payer: "x-x402-payer",
  transaction: "x-x402-transaction",
} as const;

const INTERNAL_PAYMENT_HEADERS = new Set<string>([
  "payment-signature",
  "payment-required",
  "payment-response",
  "x-payment",
  "x-payment-response",
  "x-x402-lease",
  ...Object.values(PAYMENT_METADATA_HEADERS),
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

export function isValidHttpHeaderName(name: string): boolean {
  return HEADER_NAME_TOKEN_REGEX.test(name);
}

/**
 * Rejects the full control-character range (0x00-0x1F and DEL 0x7F), tab included.
 * CR/LF/NUL enable header injection and make Headers.set throw; the remaining CTLs are
 * forbidden in an RFC 9110 field value and always indicate a misconfigured credential.
 */
export function isValidHttpHeaderValue(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return false;
    }
  }
  return true;
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
 * header-name tokens, and values containing control characters are refused here as
 * defense in depth (a custom resource store may bypass validateX402Resource; an
 * invalid name or value would otherwise throw in Headers.set or enable header
 * injection).
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

/**
 * Conservative payment-metadata value guard: printable ASCII only (0x20-0x7E) with no
 * leading/trailing whitespace and at least one visible character. Stricter than
 * `isValidHttpHeaderValue` on purpose — metadata values come from facilitator/resource
 * data and there is no legitimate reason for them to contain non-ASCII or padding.
 */
function isSafePaymentMetadataValue(value: string): boolean {
  return /^[\x21-\x7E](?:[\x20-\x7E]*[\x21-\x7E])?$/.test(value);
}

function setPaymentMetadataHeader(headers: Headers, name: string, value: string | undefined): void {
  if (value === undefined || !isSafePaymentMetadataValue(value)) {
    return;
  }
  headers.set(name, value);
}

/**
 * `encodeURIComponent` that never throws: a lone surrogate (e.g. `"\uD800"`) in the input
 * makes the built-in throw `URIError`. Resource ids are operator-controlled but only
 * validated as non-empty strings (and custom stores may skip validation entirely), so a
 * mid-proxy throw here would 500 an otherwise-valid paid request. Returns null when the id
 * cannot be encoded, so the caller omits the header rather than failing the request.
 */
function tryEncodeResourceId(resourceId: string): string | null {
  try {
    return encodeURIComponent(resourceId);
  } catch {
    return null;
  }
}

/**
 * Inject the trusted `x-x402-*` payment-metadata headers on an outbound upstream
 * request. This is the single trusted injection point for these names: it writes via
 * `headers.set` directly and deliberately does NOT consult `shouldDropProxyHeader`,
 * because all nine names are internal payment headers (which exist precisely to strip
 * client-supplied values before this runs).
 *
 * Value handling:
 * - `resourceId` is written `encodeURIComponent`-encoded — resource ids may contain
 *   path-hostile characters (`/`, spaces, `%`, non-ASCII, ...); upstreams must decode
 *   `x-x402-resource-id` before comparing. An id that cannot be encoded (lone surrogate)
 *   is skipped rather than allowed to throw.
 * - `paymentId` is SDK-generated (`randomUUID`) and written as-is.
 * - Every other value is written raw only if it passes a conservative printable-ASCII
 *   guard; invalid values are skipped silently (a mid-proxy throw must never break a
 *   paid request), and absent optionals (`payer`, `transaction`) are simply omitted.
 */
export function applyPaymentMetadataHeaders(headers: Headers, metadata: X402PaymentMetadata): void {
  headers.set(PAYMENT_METADATA_HEADERS.paymentId, metadata.paymentId);
  const encodedResourceId = tryEncodeResourceId(metadata.resourceId);
  if (encodedResourceId !== null) {
    headers.set(PAYMENT_METADATA_HEADERS.resourceId, encodedResourceId);
  }
  setPaymentMetadataHeader(headers, PAYMENT_METADATA_HEADERS.scheme, metadata.scheme);
  setPaymentMetadataHeader(headers, PAYMENT_METADATA_HEADERS.network, metadata.network);
  setPaymentMetadataHeader(headers, PAYMENT_METADATA_HEADERS.amount, metadata.amount);
  setPaymentMetadataHeader(headers, PAYMENT_METADATA_HEADERS.asset, metadata.asset);
  setPaymentMetadataHeader(headers, PAYMENT_METADATA_HEADERS.payTo, metadata.payTo);
  setPaymentMetadataHeader(headers, PAYMENT_METADATA_HEADERS.payer, metadata.payer);
  setPaymentMetadataHeader(headers, PAYMENT_METADATA_HEADERS.transaction, metadata.transaction);
}
