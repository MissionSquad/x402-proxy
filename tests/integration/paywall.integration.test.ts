import type { PaywallConfig, PaywallProvider } from "@x402/core/server";
import type { PaymentRequired } from "@x402/core/types";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createX402ProxySdk } from "../../src";
import type { X402ProxySdkConfig } from "../../src/types";
import { startExpressServer, type RunningServer } from "../helpers/x402";

const SECRET = "lease-token-secret-with-32-characters";

const BROWSER_HEADERS = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
};

async function startFakeFacilitator(): Promise<RunningServer> {
  const app = express();
  app.use(express.json());
  app.get("/supported", (_req, res) => {
    res.json({
      kinds: [
        { x402Version: 2, scheme: "exact", network: "eip155:8453" },
        { x402Version: 2, scheme: "exact", network: "eip155:84532" },
      ],
      extensions: [],
      signers: {},
    });
  });
  return startExpressServer(app);
}

function sdkConfig(facilitatorUrl: string, overrides: Partial<X402ProxySdkConfig> = {}): X402ProxySdkConfig {
  return {
    defaultNetwork: "eip155:8453",
    defaultPayTo: "0xPayee",
    leaseTokenSecret: SECRET,
    facilitator: { url: facilitatorUrl },
    syncFacilitatorOnStart: true,
    security: {
      allowInsecureHttpUpstream: true,
      allowPrivateIpUpstreams: true,
    },
    endpoints: [
      {
        kind: "http",
        id: "search",
        method: "GET",
        publicPath: "/v1/search",
        upstreamUrl: "http://127.0.0.1:9/never-called",
        price: "0.02",
        mimeType: "application/json",
      },
    ],
    ...overrides,
  };
}

describe("browser paywall rendering", () => {
  let facilitator: RunningServer;

  beforeAll(async () => {
    facilitator = await startFakeFacilitator();
  });

  afterAll(async () => {
    await facilitator.close();
  });

  describe("with a custom paywall provider", () => {
    const generateHtmlCalls: Array<{ paymentRequired: PaymentRequired; config?: PaywallConfig }> = [];
    const stubPaywall: PaywallProvider = {
      generateHtml(paymentRequired, config) {
        generateHtmlCalls.push({ paymentRequired, config });
        return "<html><body>STUB-PAYWALL</body></html>";
      },
    };
    let server: RunningServer;

    beforeAll(async () => {
      const app = express();
      const sdk = createX402ProxySdk(
        sdkConfig(facilitator.url, {
          paywall: stubPaywall,
          paywallConfig: { appName: "TestApp" },
        }),
      );
      sdk.install(app);
      server = await startExpressServer(app);
    });

    afterAll(async () => {
      await server.close();
    });

    it("serves the provider HTML to unpaid browser requests", async () => {
      const response = await fetch(`${server.url}/v1/search?q=chatbot`, { headers: BROWSER_HEADERS });

      expect(response.status).toBe(402);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(await response.text()).toContain("STUB-PAYWALL");
    });

    it("passes paywall config through with testnet derived from the mainnet network", async () => {
      expect(generateHtmlCalls.length).toBeGreaterThan(0);
      const lastCall = generateHtmlCalls[generateHtmlCalls.length - 1]!;
      expect(lastCall.config?.appName).toBe("TestApp");
      // defaultNetwork eip155:8453 (Base mainnet) must NOT inherit @x402/core's
      // `testnet ?? true` default.
      expect(lastCall.config?.testnet).toBe(false);
      expect(lastCall.paymentRequired.accepts.length).toBeGreaterThan(0);
    });
  });

  describe("without a paywall provider", () => {
    let server: RunningServer;

    beforeAll(async () => {
      const app = express();
      const sdk = createX402ProxySdk(sdkConfig(facilitator.url, { paywallConfig: { appName: "TestApp" } }));
      sdk.install(app);
      server = await startExpressServer(app);
    });

    afterAll(async () => {
      await server.close();
    });

    it("falls back to the built-in page with the derived testnet flag", async () => {
      const response = await fetch(`${server.url}/v1/search?q=chatbot`, { headers: BROWSER_HEADERS });

      expect(response.status).toBe(402);
      const html = await response.text();
      expect(html).toContain("Payment Required");
      expect(html).toContain('data-testnet="false"');
    });
  });

  describe("testnet derivation for testnet networks", () => {
    const generateHtmlCalls: Array<{ config?: PaywallConfig }> = [];
    const stubPaywall: PaywallProvider = {
      generateHtml(_paymentRequired, config) {
        generateHtmlCalls.push({ config });
        return "<html><body>STUB-TESTNET-PAYWALL</body></html>";
      },
    };
    let server: RunningServer;

    beforeAll(async () => {
      const app = express();
      const sdk = createX402ProxySdk(
        sdkConfig(facilitator.url, {
          defaultNetwork: "eip155:84532",
          paywall: stubPaywall,
        }),
      );
      sdk.install(app);
      server = await startExpressServer(app);
    });

    afterAll(async () => {
      await server.close();
    });

    it("marks base-sepolia deployments as testnet", async () => {
      const response = await fetch(`${server.url}/v1/search?q=chatbot`, { headers: BROWSER_HEADERS });

      expect(response.status).toBe(402);
      expect(await response.text()).toContain("STUB-TESTNET-PAYWALL");
      expect(generateHtmlCalls[generateHtmlCalls.length - 1]!.config?.testnet).toBe(true);
    });
  });
});
