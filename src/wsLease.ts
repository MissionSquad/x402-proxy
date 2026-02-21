import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type { RequestHandler } from "express";

import { LeaseTokenError } from "./errors";
import type { WebSocketProxyEndpointConfig } from "./types";

export type LeaseTokenPayload = {
  endpointId: string;
  exp: number;
  jti: string;
  upstreamWsUrl: string;
};

export type LeaseIssueResult = {
  token: string;
  wsUrl: string;
  expiresAt: string;
  leaseSeconds: number;
};

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function base64UrlDecode(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

function signPayload(payloadPart: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadPart).digest("base64url");
}

function createWsOrigin(baseUrl: URL): string {
  const wsProtocol = baseUrl.protocol === "https:" ? "wss:" : "ws:";
  return `${wsProtocol}//${baseUrl.host}`;
}

function inferPublicBaseUrl(request: {
  protocol: string;
  host: string | undefined;
  originalUrl: string;
}): URL {
  const host = request.host;
  if (!host) {
    throw new LeaseTokenError("Unable to infer public base URL from request headers");
  }
  const requestUrl = new URL(request.originalUrl, `${request.protocol}://${host}`);
  return new URL(`${requestUrl.protocol}//${requestUrl.host}`);
}

/**
 * Create an opaque signed lease token for WebSocket access.
 */
export function createLeaseToken(payload: LeaseTokenPayload, secret: string): string {
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = signPayload(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

/**
 * Verify and decode an opaque signed lease token.
 *
 * @throws LeaseTokenError When token format/signature/expiry is invalid.
 */
export function verifyLeaseToken(token: string, secret: string, nowUnixSeconds?: number): LeaseTokenPayload {
  const [encodedPayload, encodedSignature] = token.split(".");
  if (!encodedPayload || !encodedSignature) {
    throw new LeaseTokenError("Invalid lease token format");
  }

  const expectedSignature = signPayload(encodedPayload, secret);
  const expected = Buffer.from(expectedSignature);
  const received = Buffer.from(encodedSignature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    throw new LeaseTokenError("Invalid lease token signature");
  }

  let payload: LeaseTokenPayload;
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload)) as LeaseTokenPayload;
  } catch {
    throw new LeaseTokenError("Invalid lease token payload");
  }

  const now = nowUnixSeconds ?? Math.floor(Date.now() / 1000);
  if (payload.exp <= now) {
    throw new LeaseTokenError("Lease token expired", { exp: payload.exp, now });
  }

  return payload;
}

/**
 * Issue a new lease token and response payload.
 */
export function issueLease(
  endpoint: Pick<WebSocketProxyEndpointConfig, "id" | "leaseSeconds" | "upstreamWsUrl" | "wsPath">,
  secret: string,
  requestBaseUrl: URL,
): LeaseIssueResult {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + endpoint.leaseSeconds;
  const token = createLeaseToken(
    {
      endpointId: endpoint.id,
      exp,
      jti: randomUUID(),
      upstreamWsUrl: endpoint.upstreamWsUrl,
    },
    secret,
  );

  const wsOrigin = createWsOrigin(requestBaseUrl);
  const wsUrl = `${wsOrigin}${endpoint.wsPath}?t=${encodeURIComponent(token)}`;
  return {
    token,
    wsUrl,
    expiresAt: new Date(exp * 1000).toISOString(),
    leaseSeconds: endpoint.leaseSeconds,
  };
}

type CreateLeaseHandlerInput = {
  endpoint: WebSocketProxyEndpointConfig;
  secret: string;
  publicBaseUrl?: string;
};

/**
 * Create paid lease endpoint handler for a WebSocket endpoint.
 */
export function createLeaseHandler(input: CreateLeaseHandlerInput): RequestHandler {
  return (_req, res) => {
    const request = _req;
    const baseUrl = input.publicBaseUrl
      ? new URL(input.publicBaseUrl)
      : inferPublicBaseUrl({
          protocol: request.protocol,
          host: request.get("host") ?? undefined,
          originalUrl: request.originalUrl,
        });
    const lease = issueLease(input.endpoint, input.secret, baseUrl);
    res.status(200).json(lease);
  };
}
