import { describe, expect, it } from "vitest";

import { RouteBuildError } from "../../src/errors";
import { endpointToResource } from "../../src/resourceRuntime";
import type { ProxyEndpointConfig } from "../../src/types";

const defaults = { network: "eip155:8453" as const, payTo: "0xDefault" };

describe("endpointToResource", () => {
  it("maps an http endpoint with currency override and headers", () => {
    const endpoint: ProxyEndpointConfig = {
      kind: "http",
      id: "summary",
      method: "POST",
      publicPath: "/api/summary",
      upstreamUrl: "https://upstream.test/summary",
      price: "0.01",
      currency: { asset: "0xAsset", decimals: 6 },
      headers: { presets: ["api-auth"] },
    };
    const resource = endpointToResource(endpoint, defaults);
    expect(resource.kind).toBe("http");
    expect(resource.pricing.asset).toBe("0xAsset");
    expect(resource.pricing.decimals).toBe(6);
    expect(resource.headers).toEqual({ presets: ["api-auth"] });
    expect(resource.access).toEqual({ mode: "pass-through" });
  });

  it("falls back to defaults and maps a websocket endpoint", () => {
    const endpoint: ProxyEndpointConfig = {
      kind: "websocket",
      id: "feed",
      leasePath: "/ws/feed/lease",
      wsPath: "/ws/feed",
      upstreamWsUrl: "wss://upstream.test/feed",
      price: "0.02",
      leaseSeconds: 120,
      currency: { decimals: 9 },
    };
    const resource = endpointToResource(endpoint, defaults);
    expect(resource.kind).toBe("websocket");
    expect(resource.method).toBe("GET");
    expect(resource.pricing.network).toBe("eip155:8453");
    expect(resource.pricing.payTo).toBe("0xDefault");
    expect(resource.pricing.decimals).toBe(9);
    expect(resource.stream).toEqual({
      leasePath: "/ws/feed/lease",
      leaseSeconds: 120,
      allowRenewal: false,
      renewalWindowSeconds: 0,
    });
  });

  it("uses explicit endpoint network/payTo over defaults", () => {
    const endpoint: ProxyEndpointConfig = {
      kind: "http",
      id: "h",
      method: "GET",
      publicPath: "/api/h",
      upstreamUrl: "https://upstream.test/h",
      price: "0.01",
      network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      payTo: "0xOverride",
    };
    const resource = endpointToResource(endpoint, defaults);
    expect(resource.pricing.network).toBe("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
    expect(resource.pricing.payTo).toBe("0xOverride");
  });

  it("throws on an unsupported endpoint kind", () => {
    expect(() => endpointToResource({ kind: "bogus" } as unknown as ProxyEndpointConfig, defaults)).toThrow(
      RouteBuildError,
    );
  });
});
