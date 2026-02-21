import { createServer, type Server } from "node:http";

import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import express, { type Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createX402ProxySdk, verifyLeaseToken } from "../../src";
import type { X402ProxySdkConfig } from "../../src/types";

type RunningServer = {
  server: Server;
  url: string;
  close: () => Promise<void>;
};

async function startExpressServer(app: Express): Promise<RunningServer> {
  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve listen address");
  }

  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

async function readPaymentRequirement(
  url: string,
  method: "GET" | "POST" = "GET",
): Promise<{ paymentRequired: PaymentRequired; accepted: PaymentRequirements }> {
  const response = await fetch(url, { method });
  expect(response.status).toBe(402);
  const encoded = response.headers.get("payment-required");
  expect(encoded).toBeTruthy();
  if (!encoded) {
    throw new Error("Missing PAYMENT-REQUIRED header");
  }
  const paymentRequired = decodePaymentRequiredHeader(encoded);
  const accepted = paymentRequired.accepts[0];
  if (!accepted) {
    throw new Error("Expected at least one payment requirement");
  }
  return { paymentRequired, accepted };
}

function buildPaymentHeader(paymentRequired: PaymentRequired, accepted: PaymentRequirements): string {
  const payload: PaymentPayload = {
    x402Version: paymentRequired.x402Version,
    resource: paymentRequired.resource,
    accepted,
    payload: { test: true },
  };
  return encodePaymentSignatureHeader(payload);
}

describe("x402 proxy sdk integration", () => {
  let facilitatorServer: RunningServer;
  let upstreamServer: RunningServer;
  let proxyServer: RunningServer;
  const settleCalls: Array<{ network: string }> = [];

  beforeAll(async () => {
    const facilitatorApp = express();
    facilitatorApp.use(express.json());
    facilitatorApp.get("/supported", (_req, res) => {
      res.json({
        kinds: [
          { x402Version: 2, scheme: "exact", network: "eip155:8453" },
          { x402Version: 2, scheme: "exact", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" },
        ],
        extensions: [],
        signers: {},
      });
    });
    facilitatorApp.post("/verify", (_req, res) => {
      res.json({ isValid: true, payer: "payer" });
    });
    facilitatorApp.post("/settle", (req, res) => {
      const network = (req.body as { paymentRequirements?: { network?: string } }).paymentRequirements
        ?.network;
      settleCalls.push({ network: network ?? "unknown" });
      res.json({ success: true, transaction: "0xsettled", network: network ?? "eip155:8453" });
    });
    facilitatorServer = await startExpressServer(facilitatorApp);

    const upstreamApp = express();
    upstreamApp.use(express.json());
    upstreamApp.get("/ok-evm", (_req, res) => {
      res.json({ ok: true, family: "evm" });
    });
    upstreamApp.get("/ok-svm", (_req, res) => {
      res.json({ ok: true, family: "svm" });
    });
    upstreamApp.get("/upstream-error", (_req, res) => {
      res.status(500).json({ error: "upstream failure" });
    });
    upstreamServer = await startExpressServer(upstreamApp);

    const app = express();
    const sdkConfig: X402ProxySdkConfig = {
      defaultNetwork: "eip155:8453",
      defaultPayTo: "0xPayee",
      leaseTokenSecret: "lease-token-secret-with-32-characters",
      facilitator: { url: facilitatorServer.url },
      syncFacilitatorOnStart: true,
      security: {
        allowInsecureHttpUpstream: true,
        allowPrivateIpUpstreams: true,
      },
      discovery: {
        enabled: true,
        publicBaseUrl: "https://api.example.com",
      },
      endpoints: [
        {
          kind: "http",
          id: "evm-ok",
          method: "GET",
          publicPath: "/api/evm/ok",
          upstreamUrl: `${upstreamServer.url}/ok-evm`,
          network: "eip155:8453",
          price: "0.01",
        },
        {
          kind: "http",
          id: "svm-ok",
          method: "GET",
          publicPath: "/api/svm/ok",
          upstreamUrl: `${upstreamServer.url}/ok-svm`,
          network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
          price: "0.02",
        },
        {
          kind: "http",
          id: "upstream-error",
          method: "GET",
          publicPath: "/api/upstream/error",
          upstreamUrl: `${upstreamServer.url}/upstream-error`,
          network: "eip155:8453",
          price: "0.03",
        },
        {
          kind: "websocket",
          id: "trades",
          leasePath: "/api/ws/trades/lease",
          wsPath: "/ws/trades",
          upstreamWsUrl: "wss://upstream.example.com/ws/trades",
          network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
          price: "0.05",
          leaseSeconds: 60,
        },
      ],
    };

    const sdk = createX402ProxySdk(sdkConfig);
    sdk.install(app);
    proxyServer = await startExpressServer(app);
  });

  afterAll(async () => {
    await Promise.all([proxyServer.close(), facilitatorServer.close(), upstreamServer.close()]);
  });

  it("returns 402 + PAYMENT-REQUIRED for unpaid HTTP requests", async () => {
    const response = await fetch(`${proxyServer.url}/api/evm/ok`);
    expect(response.status).toBe(402);
    expect(response.headers.get("payment-required")).toBeTruthy();
  });

  it("proxies paid EVM request and returns PAYMENT-RESPONSE header", async () => {
    const { paymentRequired, accepted } = await readPaymentRequirement(`${proxyServer.url}/api/evm/ok`);
    const response = await fetch(`${proxyServer.url}/api/evm/ok`, {
      headers: { "PAYMENT-SIGNATURE": buildPaymentHeader(paymentRequired, accepted) },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("payment-response")).toBeTruthy();
    expect(await response.json()).toEqual({ ok: true, family: "evm" });
  });

  it("proxies paid SVM request and returns PAYMENT-RESPONSE header", async () => {
    const { paymentRequired, accepted } = await readPaymentRequirement(`${proxyServer.url}/api/svm/ok`);
    const response = await fetch(`${proxyServer.url}/api/svm/ok`, {
      headers: { "PAYMENT-SIGNATURE": buildPaymentHeader(paymentRequired, accepted) },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("payment-response")).toBeTruthy();
    expect(await response.json()).toEqual({ ok: true, family: "svm" });
  });

  it("skips settlement when upstream responds with >= 400", async () => {
    const before = settleCalls.length;
    const { paymentRequired, accepted } = await readPaymentRequirement(
      `${proxyServer.url}/api/upstream/error`,
    );
    const response = await fetch(`${proxyServer.url}/api/upstream/error`, {
      headers: { "PAYMENT-SIGNATURE": buildPaymentHeader(paymentRequired, accepted) },
    });
    expect(response.status).toBe(500);
    expect(response.headers.get("payment-response")).toBeNull();
    expect(settleCalls.length).toBe(before);
  });

  it("returns 402 for unpaid WS lease endpoint", async () => {
    const response = await fetch(`${proxyServer.url}/api/ws/trades/lease`, { method: "POST" });
    expect(response.status).toBe(402);
    expect(response.headers.get("payment-required")).toBeTruthy();
  });

  it("issues lease token for paid WS lease endpoint", async () => {
    const { paymentRequired, accepted } = await readPaymentRequirement(
      `${proxyServer.url}/api/ws/trades/lease`,
      "POST",
    );
    const response = await fetch(`${proxyServer.url}/api/ws/trades/lease`, {
      method: "POST",
      headers: { "PAYMENT-SIGNATURE": buildPaymentHeader(paymentRequired, accepted) },
    });

    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      token: string;
      wsUrl: string;
      expiresAt: string;
      leaseSeconds: number;
    };
    expect(data.leaseSeconds).toBe(60);
    expect(data.wsUrl.startsWith("wss://api.example.com/ws/trades?t=")).toBe(true);

    const decoded = verifyLeaseToken(data.token, "lease-token-secret-with-32-characters");
    expect(decoded.endpointId).toBe("trades");
    expect(decoded.upstreamWsUrl).toBe("wss://upstream.example.com/ws/trades");
  });

  it("serves discovery resources including HTTP and WS lease URLs", async () => {
    const response = await fetch(`${proxyServer.url}/x402-discovery.json`);
    expect(response.status).toBe(200);
    const discovery = (await response.json()) as { resources: string[]; version: number };
    expect(discovery.version).toBe(1);
    expect(discovery.resources).toContain("https://api.example.com/api/evm/ok");
    expect(discovery.resources).toContain("https://api.example.com/api/svm/ok");
    expect(discovery.resources).toContain("https://api.example.com/api/ws/trades/lease");
  });
});
