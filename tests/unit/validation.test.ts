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
    config.endpoints?.push({
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
    const wsEndpoint = config.endpoints?.find((endpoint) => endpoint.kind === "websocket");
    if (!wsEndpoint || wsEndpoint.kind !== "websocket") {
      throw new Error("Missing websocket endpoint in test fixture");
    }
    wsEndpoint.leaseSeconds = 0;
    expect(() => validateProxySdkConfig(config)).toThrow(ValidationError);
  });

  function expectError(mutate: (config: X402ProxySdkConfig) => void, fragment: string): void {
    const config = createValidConfig();
    mutate(config);
    try {
      validateProxySdkConfig(config);
      throw new Error("expected ValidationError");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const errors = (error as ValidationError).context?.errors as string[];
      expect(errors.some((message) => message.includes(fragment))).toBe(true);
    }
  }

  it("validates each field with a specific message", () => {
    expectError((c) => {
      (c.endpoints?.[0] as { id: string }).id = "";
    }, "endpoint id must be a non-empty string");
    expectError((c) => {
      c.defaultPayTo = "";
    }, "defaultPayTo must be a non-empty string");
    expectError((c) => {
      c.endpoints = [];
      delete c.resourceStore;
    }, "endpoints must contain at least one endpoint");
    expectError((c) => {
      (c.endpoints?.[0] as { network: string }).network = "bad";
    }, "network must be CAIP-2");
    expectError((c) => {
      (c.endpoints?.[0] as { payTo: string }).payTo = "   ";
    }, "payTo must be a non-empty string when provided");
    expectError((c) => {
      (c.endpoints?.[0] as { price: string }).price = "abc";
    }, "price must match");
    expectError((c) => {
      (c.endpoints?.[0] as { price: string }).price = "0";
    }, "price must be > 0");
    expectError((c) => {
      (c.endpoints?.[0] as { publicPath: string }).publicPath = "no-slash";
    }, 'publicPath must start with "/"');
    expectError((c) => {
      (c.endpoints?.[0] as { upstreamUrl: string }).upstreamUrl = "ftp://x";
    }, "upstreamUrl must use http: or https:");
    expectError((c) => {
      (c.endpoints?.[1] as { leasePath: string }).leasePath = "x";
    }, 'leasePath must start with "/"');
    expectError((c) => {
      (c.endpoints?.[1] as { wsPath: string }).wsPath = "x";
    }, 'wsPath must start with "/"');
    expectError((c) => {
      (c.endpoints?.[1] as { upstreamWsUrl: string }).upstreamWsUrl = "https://x";
    }, "upstreamWsUrl must use ws: or wss:");
    expectError((c) => {
      (c.endpoints?.[0] as { id: string }).id = "trades";
    }, "duplicate endpoint id");
    expectError((c) => {
      c.discovery = { enabled: true, publicBaseUrl: "" };
    }, "discovery.publicBaseUrl must be provided");
    expectError((c) => {
      c.discovery = { enabled: true, publicBaseUrl: "ftp://x" };
    }, "discovery.publicBaseUrl must use http: or https:");
    expectError((c) => {
      c.discovery = { enabled: true, publicBaseUrl: "::::" };
    }, "discovery.publicBaseUrl must be a valid URL");
  });

  it("rejects duplicate websocket lease and ws paths", () => {
    expectError((c) => {
      c.endpoints?.push({
        kind: "websocket",
        id: "trades-2",
        leasePath: "/api/ws/trades/lease",
        wsPath: "/ws/trades-2",
        upstreamWsUrl: "wss://upstream.example.com/ws/trades-2",
        leaseSeconds: 60,
        price: "0.02",
      });
    }, "duplicate websocket leasePath");
    expectError((c) => {
      c.endpoints?.push({
        kind: "websocket",
        id: "trades-3",
        leasePath: "/api/ws/trades-3/lease",
        wsPath: "/ws/trades",
        upstreamWsUrl: "wss://upstream.example.com/ws/trades-3",
        leaseSeconds: 60,
        price: "0.02",
      });
    }, "duplicate websocket wsPath");
  });

  it("validates the payment metadata options", () => {
    expectError((c) => {
      (c as { forwardPaymentMetadata?: unknown }).forwardPaymentMetadata = "yes";
    }, "forwardPaymentMetadata must be a boolean when provided");
    expectError((c) => {
      (c as { onPaymentSettled?: unknown }).onPaymentSettled = "not-a-function";
    }, "onPaymentSettled must be a function when provided");

    const config = createValidConfig();
    config.forwardPaymentMetadata = false;
    config.onPaymentSettled = () => undefined;
    expect(() => validateProxySdkConfig(config)).not.toThrow();
  });

  it("accepts a config with a resourceStore and no endpoints", () => {
    expect(() =>
      validateProxySdkConfig({
        defaultNetwork: "eip155:8453",
        defaultPayTo: "0xPayee",
        leaseTokenSecret: "lease-token-secret-with-32-characters",
        resourceStore: {
          listEnabledResources: async () => [],
          getResourceById: async () => null,
          getResourceForRequest: async () => null,
        },
      }),
    ).not.toThrow();
  });
});
