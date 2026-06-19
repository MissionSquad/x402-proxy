import type { Request, Response } from "express";

import type { X402HeaderPolicy, X402HeaderPreset } from "./types";

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

const RESPONSE_PRESET_HEADERS: Record<X402HeaderPreset, string[]> = {
  none: [],
  "api-auth": [],
  "browser-auth": [],
  streaming: ["content-type", "cache-control", "connection", "x-accel-buffering", "x-run-id"],
};

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

  const headers = new Headers();
  for (const [headerName, headerValue] of Object.entries(req.headers)) {
    const lower = headerName.toLowerCase();
    if (!allowed.has(lower) || shouldDropProxyHeader(lower)) {
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
  for (const header of normalizeHeaderList(policy?.forwardResponseHeaders)) {
    allowed.add(header);
  }

  for (const [headerName, headerValue] of upstreamResponse.headers.entries()) {
    const lower = headerName.toLowerCase();
    if (!allowed.has(lower) || shouldDropProxyHeader(lower)) {
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
