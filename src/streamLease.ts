import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { LeaseTokenError } from "./errors";
import type { HttpMethod, X402Resource } from "./types";

/**
 * Optional settled-payment details embedded in a lease token at issuance (0.2.1+), so
 * the later relay request can forward trusted payment metadata — including
 * `payer`/`transaction`, which are known here because lease issuance settles before
 * the stream request happens. Tokens minted by older versions simply lack these
 * fields; verification and relay treat them as absent.
 */
export type HttpStreamLeasePaymentInfo = {
  paymentId?: string;
  payer?: string;
  transaction?: string;
  scheme?: string;
  network?: string;
  amount?: string;
  asset?: string;
  payTo?: string;
};

export type HttpStreamLeasePayload = {
  resourceId: string;
  exp: number;
  jti: string;
  method: HttpMethod;
  publicPath: string;
  upstreamUrl: string;
} & HttpStreamLeasePaymentInfo;

export type HttpStreamLeaseIssueResult = {
  token: string;
  streamUrl: string;
  expiresAt: string;
  leaseSeconds: number;
};

export interface X402LeaseUseStore {
  consume(jti: string, exp: number): Promise<boolean>;
}

export class InMemoryX402LeaseUseStore implements X402LeaseUseStore {
  private readonly consumed = new Map<string, number>();

  public async consume(jti: string, exp: number): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    for (const [key, value] of this.consumed.entries()) {
      if (value <= now) {
        this.consumed.delete(key);
      }
    }
    if (this.consumed.has(jti)) {
      return false;
    }
    this.consumed.set(jti, exp);
    return true;
  }
}

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function base64UrlDecode(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

function signPayload(payloadPart: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadPart).digest("base64url");
}

function createHttpOrigin(baseUrl: URL): string {
  return `${baseUrl.protocol}//${baseUrl.host}`;
}

export function createHttpStreamLeaseToken(payload: HttpStreamLeasePayload, secret: string): string {
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = signPayload(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

export function verifyHttpStreamLeaseToken(
  token: string,
  secret: string,
  expected: Pick<HttpStreamLeasePayload, "resourceId" | "method" | "publicPath" | "upstreamUrl">,
  nowUnixSeconds?: number,
): HttpStreamLeasePayload {
  const [encodedPayload, encodedSignature] = token.split(".");
  if (!encodedPayload || !encodedSignature) {
    throw new LeaseTokenError("Invalid lease token format");
  }

  const expectedSignature = signPayload(encodedPayload, secret);
  const expectedBuffer = Buffer.from(expectedSignature);
  const receivedBuffer = Buffer.from(encodedSignature);
  if (expectedBuffer.length !== receivedBuffer.length || !timingSafeEqual(expectedBuffer, receivedBuffer)) {
    throw new LeaseTokenError("Invalid lease token signature");
  }

  let payload: HttpStreamLeasePayload;
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload)) as HttpStreamLeasePayload;
  } catch {
    throw new LeaseTokenError("Invalid lease token payload");
  }

  const now = nowUnixSeconds ?? Math.floor(Date.now() / 1000);
  if (payload.exp <= now) {
    throw new LeaseTokenError("Lease token expired", { exp: payload.exp, now });
  }

  if (
    payload.resourceId !== expected.resourceId ||
    payload.method !== expected.method ||
    payload.publicPath !== expected.publicPath ||
    payload.upstreamUrl !== expected.upstreamUrl
  ) {
    throw new LeaseTokenError("Lease token resource mismatch");
  }

  return payload;
}

export function issueHttpStreamLease(
  resource: Pick<X402Resource, "id" | "method" | "publicPath" | "upstreamUrl" | "stream">,
  secret: string,
  requestBaseUrl: URL,
  params: Record<string, string>,
  payment?: HttpStreamLeasePaymentInfo,
): HttpStreamLeaseIssueResult {
  if (!resource.stream) {
    throw new LeaseTokenError("Stream resource is missing lease config", { resourceId: resource.id });
  }
  const now = Math.floor(Date.now() / 1000);
  const exp = now + resource.stream.leaseSeconds;
  const token = createHttpStreamLeaseToken(
    {
      ...payment,
      resourceId: resource.id,
      exp,
      jti: randomUUID(),
      method: resource.method,
      publicPath: resource.publicPath,
      upstreamUrl: resource.upstreamUrl,
    },
    secret,
  );

  let streamPath = resource.publicPath;
  for (const [name, value] of Object.entries(params)) {
    streamPath = streamPath.replace(`[${name}]`, encodeURIComponent(value));
  }
  const streamUrl = new URL(streamPath, createHttpOrigin(requestBaseUrl));
  streamUrl.searchParams.set("t", token);

  return {
    token,
    streamUrl: streamUrl.toString(),
    expiresAt: new Date(exp * 1000).toISOString(),
    leaseSeconds: resource.stream.leaseSeconds,
  };
}
