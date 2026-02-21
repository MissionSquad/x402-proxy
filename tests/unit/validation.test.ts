import { describe, expect, it } from "vitest";

import { ValidationError } from "../../src/errors";
import type { X402ProxySdkConfig } from "../../src/types";
import { validateProxySdkConfig } from "../../src/validation";

function createValidConfig(): X402ProxySdkConfig {
  return {
    defaultNetwork: "eip155:8453",
    defaultPayTo: "0xPayee",
    leaseTokenSecret: "lease-token-secret-with-32-characters",
    endpoints: [
      {
        kind: "http",
        id: "prices",
        method: "GET",
        publicPath: "/api/prices",
        upstreamUrl: "https://upstream.example.com/prices",
        price: "0.01",
      },
      {
        kind: "websocket",
        id: "trades",
        leasePath: "/api/ws/trades/lease",
        wsPath: "/ws/trades",
        upstreamWsUrl: "wss://upstream.example.com/ws/trades",
        leaseSeconds: 60,
        price: "0.02",
      },
    ],
  };
}

describe("validateProxySdkConfig", () => {
  it("accepts valid config", () => {
    expect(() => validateProxySdkConfig(createValidConfig())).not.toThrow();
  });

  it("rejects short lease secret", () => {
    const config = createValidConfig();
    config.leaseTokenSecret = "short";
    expect(() => validateProxySdkConfig(config)).toThrow(ValidationError);
  });

  it("rejects duplicate HTTP route keys", () => {
    const config = createValidConfig();
    config.endpoints.push({
      kind: "http",
      id: "prices-2",
      method: "GET",
      publicPath: "/api/prices",
      upstreamUrl: "https://upstream.example.com/prices-2",
      price: "0.1",
    });
    expect(() => validateProxySdkConfig(config)).toThrow(ValidationError);
  });

  it("rejects invalid network format", () => {
    const config = createValidConfig();
    config.defaultNetwork = "eth-mainnet" as X402ProxySdkConfig["defaultNetwork"];
    expect(() => validateProxySdkConfig(config)).toThrow(ValidationError);
  });

  it("rejects websocket endpoint with non-positive leaseSeconds", () => {
    const config = createValidConfig();
    const wsEndpoint = config.endpoints.find((endpoint) => endpoint.kind === "websocket");
    if (!wsEndpoint || wsEndpoint.kind !== "websocket") {
      throw new Error("Missing websocket endpoint in test fixture");
    }
    wsEndpoint.leaseSeconds = 0;
    expect(() => validateProxySdkConfig(config)).toThrow(ValidationError);
  });
});
