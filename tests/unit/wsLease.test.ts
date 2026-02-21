import { describe, expect, it } from "vitest";

import { LeaseTokenError } from "../../src/errors";
import { createLeaseToken, issueLease, verifyLeaseToken } from "../../src/wsLease";

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
});
