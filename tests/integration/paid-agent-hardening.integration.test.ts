import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";

import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import express, { type Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createX402ProxySdk, InMemoryX402ResourceStore } from "../../src";
import { createHttpStreamLeaseToken } from "../../src/streamLease";
import type { X402ProxySdkConfig, X402Resource } from "../../src/types";

type RunningServer = {
  server: Server;
  url: string;
  close: () => Promise<void>;
};

const LEASE_SECRET = "lease-token-secret-with-32-characters";

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
): Promise<{ paymentRequired: PaymentRequired; accepted: PaymentRequirements }> {
  const response = await fetch(url, { method: "POST" });
  expect(response.status).toBe(402);
  const encoded = response.headers.get("payment-required");
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

describe("paid agent hardening integration", () => {
  let facilitatorServer: RunningServer;
  let upstreamServer: RunningServer;
  let proxyServer: RunningServer;
  let streamResource: X402Resource;
  const summaryHits: Array<{ authorization: string | null; cookie: string | null }> = [];
  let upstreamStreamClosed: Promise<void>;
  let resolveUpstreamStreamClosed: () => void;

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
    facilitatorApp.post("/settle", (_req, res) => {
      res.json({ success: true, transaction: "0xsettled", network: "eip155:8453" });
    });
    facilitatorServer = await startExpressServer(facilitatorApp);

    upstreamStreamClosed = new Promise<void>((resolve) => {
      resolveUpstreamStreamClosed = resolve;
    });

    const upstreamApp = express();
    upstreamApp.use(express.json());
    upstreamApp.post("/internal/agent/:username/summary", (req, res) => {
      summaryHits.push({
        authorization: req.get("authorization") ?? null,
        cookie: req.get("cookie") ?? null,
      });
      res.json({ username: req.params.username });
    });
    upstreamApp.post("/internal/chat/:username", (req, res) => {
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("cache-control", "no-cache");
      res.write("data: first\n\n");
      // Keep the stream open until the proxy aborts; resolve when the socket closes.
      res.on("close", () => {
        resolveUpstreamStreamClosed();
      });
    });
    upstreamServer = await startExpressServer(upstreamApp);

    const now = Date.now();
    streamResource = {
      id: "hardening-chat-stream",
      enabled: true,
      kind: "http-stream",
      method: "POST",
      publicPath: "/paid/chat/[username]",
      upstreamUrl: `${upstreamServer.url}/internal/chat/[username]`,
      pricing: { amount: "0.02", network: "eip155:8453", payTo: "0xPayee" },
      headers: { presets: ["api-auth", "streaming"] },
      stream: {
        leasePath: "/paid/chat/[username]/lease",
        leaseSeconds: 60,
        allowRenewal: false,
        renewalWindowSeconds: 10,
      },
      createdAt: now,
      updatedAt: now,
    };
    const resources: X402Resource[] = [
      {
        id: "hardening-svc-summary",
        enabled: true,
        kind: "http",
        method: "POST",
        publicPath: "/paid/svc/[username]/summary",
        upstreamUrl: `${upstreamServer.url}/internal/agent/[username]/summary`,
        pricing: { amount: "0.01", network: "eip155:8453", payTo: "0xPayee" },
        headers: { presets: ["browser-auth"], excludeRequestHeaders: ["cookie"] },
        access: {
          mode: "service-token",
          serviceTokenHeader: "Authorization",
          serviceTokenValue: "Bearer service-secret",
        },
        createdAt: now,
        updatedAt: now,
      },
      streamResource,
    ];

    const app = express();
    const sdkConfig: X402ProxySdkConfig = {
      defaultNetwork: "eip155:8453",
      defaultPayTo: "0xPayee",
      leaseTokenSecret: LEASE_SECRET,
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

  it("injects the service token upstream, replacing client credentials and honoring excludes", async () => {
    const url = `${proxyServer.url}/paid/svc/jayson/summary`;
    const { paymentRequired, accepted } = await readPaymentRequirement(url);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "PAYMENT-SIGNATURE": buildPaymentHeader(paymentRequired, accepted),
        Authorization: "Bearer client-token",
        Cookie: "session=client-session",
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ username: "jayson" });
    expect(summaryHits.at(-1)).toEqual({
      authorization: "Bearer service-secret",
      cookie: null,
    });
  });

  it("rejects an expired stream lease token end-to-end", async () => {
    const expiredToken = createHttpStreamLeaseToken(
      {
        resourceId: streamResource.id,
        exp: Math.floor(Date.now() / 1000) - 10,
        jti: randomUUID(),
        method: streamResource.method,
        publicPath: streamResource.publicPath,
        upstreamUrl: streamResource.upstreamUrl,
      },
      LEASE_SECRET,
    );

    const response = await fetch(
      `${proxyServer.url}/paid/chat/jayson?t=${encodeURIComponent(expiredToken)}`,
      { method: "POST" },
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid x402 lease token" });
  });

  it("aborts the upstream streaming request when the client disconnects", async () => {
    const leasePath = `${proxyServer.url}/paid/chat/jayson/lease`;
    const { paymentRequired, accepted } = await readPaymentRequirement(leasePath);
    const leaseResponse = await fetch(leasePath, {
      method: "POST",
      headers: { "PAYMENT-SIGNATURE": buildPaymentHeader(paymentRequired, accepted) },
    });
    expect(leaseResponse.status).toBe(200);
    const lease = (await leaseResponse.json()) as { streamUrl: string };

    const controller = new AbortController();
    const streamResponse = await fetch(lease.streamUrl, {
      method: "POST",
      signal: controller.signal,
    });
    expect(streamResponse.status).toBe(200);
    const reader = streamResponse.body?.getReader();
    if (!reader) {
      throw new Error("Expected a readable stream body");
    }
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("data: first");

    controller.abort();

    await expect(
      Promise.race([
        upstreamStreamClosed,
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error("upstream request was not aborted")), 5_000);
        }),
      ]),
    ).resolves.toBeUndefined();
  });
});
