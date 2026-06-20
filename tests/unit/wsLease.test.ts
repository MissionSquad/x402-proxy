import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { LeaseTokenError } from "../../src/errors";
import type { WebSocketProxyEndpointConfig } from "../../src/types";
import { createLeaseHandler, createLeaseToken, issueLease, verifyLeaseToken } from "../../src/wsLease";
import { createFakeRequest, FakeResponse } from "../helpers/fakeHttp";

const SECRET = "lease-token-secret-with-32-characters";

const wsEndpoint: WebSocketProxyEndpointConfig = {
  kind: "websocket",
  id: "trades",
  leasePath: "/lease",
  wsPath: "/ws/trades",
  upstreamWsUrl: "wss://upstream.example.com/ws/trades",
  leaseSeconds: 60,
  price: "0.01",
};

describe("wsLease", () => {
  it("signs and verifies lease tokens", () => {
    const secret = "lease-token-secret-with-32-characters";
    const token = createLeaseToken(
      {
        endpointId: "trades",
        exp: Math.floor(Date.now() / 1000) + 60,
        jti: "123",
        upstreamWsUrl: "wss://upstream.example.com/ws/trades",
      },
      secret,
    );

    const decoded = verifyLeaseToken(token, secret);
    expect(decoded.endpointId).toBe("trades");
    expect(decoded.jti).toBe("123");
  });

  it("rejects expired tokens", () => {
    const secret = "lease-token-secret-with-32-characters";
    const token = createLeaseToken(
      {
        endpointId: "trades",
        exp: 1,
        jti: "expired",
        upstreamWsUrl: "wss://upstream.example.com/ws/trades",
      },
      secret,
    );

    expect(() => verifyLeaseToken(token, secret, 2)).toThrow(LeaseTokenError);
  });

  it("issues wsUrl and metadata", () => {
    const secret = "lease-token-secret-with-32-characters";
    const result = issueLease(
      {
        id: "trades",
        wsPath: "/ws/trades",
        upstreamWsUrl: "wss://upstream.example.com/ws/trades",
        leaseSeconds: 60,
      },
      secret,
      new URL("https://api.example.com"),
    );

    expect(result.wsUrl.startsWith("wss://api.example.com/ws/trades?t=")).toBe(true);
    expect(result.leaseSeconds).toBe(60);
    expect(result.token.length).toBeGreaterThan(0);
  });

  it("derives a ws:// origin from an http base url", () => {
    const result = issueLease(
      { id: "x", wsPath: "/ws/x", upstreamWsUrl: "ws://u/x", leaseSeconds: 30 },
      SECRET,
      new URL("http://local.test"),
    );
    expect(result.wsUrl.startsWith("ws://local.test/ws/x?t=")).toBe(true);
  });

  it("rejects a token with no separator", () => {
    expect(() => verifyLeaseToken("nodot", SECRET)).toThrow(/Invalid lease token format/);
  });

  it("rejects a token whose signature does not match", () => {
    const [payload] = createLeaseToken(
      { endpointId: "x", exp: Math.floor(Date.now() / 1000) + 60, jti: "j", upstreamWsUrl: "wss://u" },
      SECRET,
    ).split(".");
    expect(() => verifyLeaseToken(`${payload}.deadbeef`, SECRET)).toThrow(/Invalid lease token signature/);
  });

  it("rejects a correctly-signed payload that is not valid JSON", () => {
    const encodedPayload = Buffer.from("not-json").toString("base64url");
    const sig = createHmac("sha256", SECRET).update(encodedPayload).digest("base64url");
    expect(() => verifyLeaseToken(`${encodedPayload}.${sig}`, SECRET)).toThrow(/Invalid lease token payload/);
  });
});

describe("createLeaseHandler", () => {
  it("uses a configured publicBaseUrl", () => {
    const handler = createLeaseHandler({
      endpoint: wsEndpoint,
      secret: SECRET,
      publicBaseUrl: "https://api.example.com",
    });
    const res = new FakeResponse();
    handler(createFakeRequest({ method: "POST", originalUrl: "/lease" }) as never, res as never, vi.fn());
    expect(res.statusCode).toBe(200);
    expect((res.body as { wsUrl: string }).wsUrl.startsWith("wss://api.example.com/ws/trades?t=")).toBe(true);
  });

  it("infers the base url from the request when no publicBaseUrl is set", () => {
    const handler = createLeaseHandler({ endpoint: wsEndpoint, secret: SECRET });
    const res = new FakeResponse();
    const req = createFakeRequest({
      method: "POST",
      originalUrl: "/lease",
      protocol: "https",
      headers: { host: "proxy.example.com" },
    });
    handler(req as never, res as never, vi.fn());
    expect((res.body as { wsUrl: string }).wsUrl.startsWith("wss://proxy.example.com/ws/trades?t=")).toBe(true);
  });

  it("throws LeaseTokenError when the host header is missing", () => {
    const handler = createLeaseHandler({ endpoint: wsEndpoint, secret: SECRET });
    const req = createFakeRequest({ method: "POST", originalUrl: "/lease", protocol: "https" });
    expect(() => handler(req as never, new FakeResponse() as never, vi.fn())).toThrow(LeaseTokenError);
  });
});
