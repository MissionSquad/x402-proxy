import { createServer, type Server } from "node:http";

import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import express, { type Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createX402ProxySdk, InMemoryX402ResourceStore } from "../../src";
import type { X402ProxySdkConfig, X402Resource } from "../../src/types";

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
  method: "GET" | "POST" = "POST",
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

describe("dynamic x402 resources integration", () => {
  let facilitatorServer: RunningServer;
  let upstreamServer: RunningServer;
  let proxyServer: RunningServer;
  const upstreamHits: Array<{ path: string; authorization?: string | null; payment?: string | null }> = [];

  beforeAll(async () => {
    const facilitatorApp = express();
    facilitatorApp.use(express.json());
    facilitatorApp.get("/supported", (_req, res) => {
      res.json({
        kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }],
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
      res.json({ success: true, transaction: "0xsettled", network: network ?? "eip155:8453" });
    });
    facilitatorServer = await startExpressServer(facilitatorApp);

    const upstreamApp = express();
    upstreamApp.use(express.json());
    upstreamApp.post("/v1/public/agent/:username/:slug/summary", (req, res) => {
      upstreamHits.push({
        path: req.originalUrl,
        authorization: req.get("authorization") ?? null,
        payment: req.get("payment-signature") ?? req.get("x-payment") ?? null,
      });
      res.json({ username: req.params.username, slug: req.params.slug, query: req.query.mode });
    });
    upstreamApp.post("/v1/public/agent/:username/:slug/chat", (req, res) => {
      upstreamHits.push({
        path: req.originalUrl,
        authorization: req.get("authorization") ?? null,
        payment: req.get("payment-signature") ?? req.get("x-payment") ?? null,
      });
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("cache-control", "no-cache");
      res.write("data: first\n\n");
      setTimeout(() => {
        res.write("data: second\n\n");
        res.end();
      }, 20);
    });
    upstreamServer = await startExpressServer(upstreamApp);

    const now = Date.now();
    const resources: X402Resource[] = [
      {
        id: "dynamic-summary",
        enabled: true,
        kind: "http",
        method: "POST",
        publicPath: "/paid/agents/[username]/[slug]/summary",
        upstreamUrl: `${upstreamServer.url}/v1/public/agent/[username]/[slug]/summary`,
        pricing: { amount: "0.01", network: "eip155:8453", payTo: "0xPayee" },
        headers: { presets: ["api-auth"] },
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "dynamic-chat-stream",
        enabled: true,
        kind: "http-stream",
        method: "POST",
        publicPath: "/paid/agents/[username]/[slug]/chat",
        upstreamUrl: `${upstreamServer.url}/v1/public/agent/[username]/[slug]/chat`,
        pricing: { amount: "0.02", network: "eip155:8453", payTo: "0xPayee" },
        headers: { presets: ["api-auth", "streaming"] },
        stream: {
          leasePath: "/paid/agents/[username]/[slug]/chat/lease",
          leaseSeconds: 60,
          allowRenewal: false,
          renewalWindowSeconds: 10,
        },
        createdAt: now,
        updatedAt: now,
      },
    ];

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
      resourceStore: new InMemoryX402ResourceStore(resources),
    };

    const sdk = createX402ProxySdk(sdkConfig);
    await sdk.refreshResources();
    sdk.install(app);
    proxyServer = await startExpressServer(app);
  });

  afterAll(async () => {
    await Promise.all([proxyServer.close(), facilitatorServer.close(), upstreamServer.close()]);
  });

  it("proxies dynamic paid HTTP resources with interpolated path params", async () => {
    const { paymentRequired, accepted } = await readPaymentRequirement(
      `${proxyServer.url}/paid/agents/jayson/research/summary?mode=fast`,
    );
    const response = await fetch(`${proxyServer.url}/paid/agents/jayson/research/summary?mode=fast`, {
      method: "POST",
      headers: {
        "PAYMENT-SIGNATURE": buildPaymentHeader(paymentRequired, accepted),
        Authorization: "Bearer user-token",
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("payment-response")).toBeTruthy();
    expect(await response.json()).toEqual({ username: "jayson", slug: "research", query: "fast" });
    expect(upstreamHits.at(-1)).toMatchObject({
      path: "/v1/public/agent/jayson/research/summary?mode=fast",
      authorization: "Bearer user-token",
      payment: null,
    });
  });

  it("issues paid stream leases and proxies SSE chunks without token forwarding", async () => {
    const leasePath = `${proxyServer.url}/paid/agents/jayson/research/chat/lease`;
    const { paymentRequired, accepted } = await readPaymentRequirement(leasePath);
    const leaseResponse = await fetch(leasePath, {
      method: "POST",
      headers: { "PAYMENT-SIGNATURE": buildPaymentHeader(paymentRequired, accepted) },
    });

    expect(leaseResponse.status).toBe(200);
    const lease = (await leaseResponse.json()) as { streamUrl: string; token: string };
    expect(lease.streamUrl).toContain("/paid/agents/jayson/research/chat?t=");

    const streamResponse = await fetch(lease.streamUrl, {
      method: "POST",
      headers: { Authorization: "Bearer stream-user" },
    });
    expect(streamResponse.status).toBe(200);
    expect(streamResponse.headers.get("content-type")).toContain("text/event-stream");

    const text = await streamResponse.text();
    expect(text).toContain("data: first");
    expect(text).toContain("data: second");
    expect(upstreamHits.at(-1)).toMatchObject({
      path: "/v1/public/agent/jayson/research/chat",
      authorization: "Bearer stream-user",
      payment: null,
    });

    const reuseResponse = await fetch(lease.streamUrl, { method: "POST" });
    expect(reuseResponse.status).toBe(401);
  });
});
