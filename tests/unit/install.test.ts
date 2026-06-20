import { describe, expect, it } from "vitest";

import { createX402ProxySdk } from "../../src";
import { PriceConversionError } from "../../src/errors";
import type { X402ProxySdkConfig } from "../../src/types";

const SECRET = "lease-token-secret-with-32-characters";

function baseConfig(overrides: Partial<X402ProxySdkConfig> = {}): X402ProxySdkConfig {
  return {
    defaultNetwork: "eip155:8453",
    defaultPayTo: "0xPayee",
    leaseTokenSecret: SECRET,
    syncFacilitatorOnStart: false,
    endpoints: [
      {
        kind: "http",
        id: "quotes",
        method: "GET",
        publicPath: "/api/quotes",
        upstreamUrl: "https://upstream.test/quotes",
        price: "0.01",
        mimeType: "application/json",
        maxTimeoutSeconds: 45,
        currency: { asset: "0xAsset", decimals: 6 },
      },
      {
        kind: "websocket",
        id: "trades",
        leasePath: "/api/ws/trades/lease",
        wsPath: "/ws/trades",
        upstreamWsUrl: "wss://upstream.test/trades",
        price: "0.02",
        leaseSeconds: 60,
        mimeType: "application/json",
        maxTimeoutSeconds: 30,
      },
    ],
    ...overrides,
  };
}

describe("createX402ProxySdk - static endpoint build", () => {
  it("builds http + websocket routes and reports diagnostics", () => {
    const sdk = createX402ProxySdk(
      baseConfig({
        discovery: { enabled: true, publicBaseUrl: "https://api.example.com" },
        facilitator: { url: "https://facilitator.example.com" },
      }),
    );

    expect(Object.keys(sdk.routes).sort()).toEqual(["GET /api/quotes", "POST /api/ws/trades/lease"]);
    expect(sdk.routes["GET /api/quotes"]?.resource).toBe("https://api.example.com/api/quotes");

    const diagnostics = sdk.diagnostics();
    expect(diagnostics.storeType).toBe("InMemoryX402ResourceStore");
    expect(diagnostics.loadedResourceCount).toBe(2);
    expect(diagnostics.facilitatorUrl).toBe("https://facilitator.example.com");
    expect(diagnostics.enabledNetworks).toContain("eip155:8453");
    expect(sdk.listLoadedResources()).toHaveLength(2);
  });

  it("omits resource discovery URLs and facilitator url when not configured", () => {
    const sdk = createX402ProxySdk(baseConfig());
    expect(sdk.routes["GET /api/quotes"]?.resource).toBeUndefined();
    expect(sdk.diagnostics().facilitatorUrl).toBeUndefined();
  });

  it("rejects an EVM currency override that omits the asset", () => {
    expect(() =>
      createX402ProxySdk(
        baseConfig({
          endpoints: [
            {
              kind: "http",
              id: "quotes",
              method: "GET",
              publicPath: "/api/quotes",
              upstreamUrl: "https://upstream.test/quotes",
              price: "0.01",
              currency: { decimals: 6 },
            },
          ],
        }),
      ),
    ).toThrow(PriceConversionError);
  });

  it("installs middleware and the diagnostics route on an app", () => {
    const registrations: string[] = [];
    const app = {
      use: (): void => {
        registrations.push("use");
      },
      get: (path: string): void => {
        registrations.push(`get ${path}`);
      },
    };
    const sdk = createX402ProxySdk(
      baseConfig({ discovery: { enabled: true, publicBaseUrl: "https://api.example.com" } }),
    );
    sdk.install(app as never);
    expect(registrations).toContain("use");
    expect(registrations).toContain("get /.well-known/x402");
    expect(registrations).toContain("get /x402/diagnostics");
  });
});
