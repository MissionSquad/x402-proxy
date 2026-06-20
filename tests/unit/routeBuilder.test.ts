import { describe, expect, it } from "vitest";

import { RouteBuildError } from "../../src/errors";
import {
  buildRouteConfig,
  buildRoutes,
  createHttpRouteKey,
  createWsLeaseRouteKey,
} from "../../src/routeBuilder";

describe("routeBuilder", () => {
  it("creates route keys", () => {
    expect(createHttpRouteKey("GET", "/api/prices")).toBe("GET /api/prices");
    expect(createWsLeaseRouteKey("/api/ws/trades/lease")).toBe("POST /api/ws/trades/lease");
  });

  it("builds HTTP and WS lease route configs", () => {
    const routes = buildRoutes([
      {
        path: "/api/prices",
        method: "GET",
        price: "0.01",
        network: "eip155:8453",
        payTo: "0xPayee",
        description: "Prices endpoint",
        publicResourceUrl: (path) => `https://api.example.com${path}`,
      },
      {
        path: "/api/ws/trades/lease",
        method: "POST",
        price: { asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", amount: "20000" },
        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        payTo: "7f7a9x4WmQmEG2E5AFf8zw8jHEm6R98mh3nHnA8uX6nW",
        description: "Trades lease endpoint",
      },
    ]);

    expect(Object.keys(routes)).toEqual(["GET /api/prices", "POST /api/ws/trades/lease"]);
    expect(routes["GET /api/prices"]?.accepts).toMatchObject({
      scheme: "exact",
      network: "eip155:8453",
      payTo: "0xPayee",
      price: "0.01",
    });
    expect(routes["GET /api/prices"]?.resource).toBe("https://api.example.com/api/prices");
    expect(routes["POST /api/ws/trades/lease"]?.accepts).toMatchObject({
      scheme: "exact",
      network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    });
  });

  it("throws on a duplicate route key", () => {
    expect(() =>
      buildRoutes([
        { path: "/p", method: "GET", price: "0.01", network: "eip155:8453", payTo: "0x", description: "a" },
        { path: "/p", method: "GET", price: "0.02", network: "eip155:8453", payTo: "0x", description: "b" },
      ]),
    ).toThrow(RouteBuildError);
  });

  it("applies default mimeType/maxTimeoutSeconds and omits an empty resource", () => {
    const config = buildRouteConfig(
      "/p",
      "0.01",
      { network: "eip155:8453", payTo: "0x", publicResourceUrl: () => undefined },
      "desc",
    );
    expect(config.mimeType).toBe("application/json");
    expect(config.accepts).toMatchObject({ maxTimeoutSeconds: 60 });
    expect(config.resource).toBeUndefined();
  });

  it("builds a route without optional fields", () => {
    const routes = buildRoutes([
      { path: "/q", method: "GET", price: "0.01", network: "eip155:8453", payTo: "0x", description: "q" },
    ]);
    expect(routes["GET /q"]?.resource).toBeUndefined();
    expect(routes["GET /q"]?.accepts).toMatchObject({ maxTimeoutSeconds: 60 });
  });
});
