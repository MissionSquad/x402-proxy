import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createX402ProxySdk, InMemoryX402AccessEventStore, InMemoryX402ResourceStore } from "../../src";
import type { X402AccessEvent, X402AccessEventStore, X402ProxySdkConfig, X402Resource } from "../../src/types";
import {
  buildPaymentHeader,
  createFacilitatorApp,
  readPaymentRequirement,
  startExpressServer,
  type FacilitatorControls,
  type RunningServer,
} from "../helpers/x402";
import express from "express";

const NETWORK = "eip155:8453";

function resources(upstreamUrl: string): X402Resource[] {
  const now = Date.now();
  const base = { enabled: true, createdAt: now, updatedAt: now, pricing: { amount: "0.01", network: NETWORK as X402Resource["pricing"]["network"], payTo: "0xPayee" } };
  return [
    {
      ...base,
      id: "summary",
      kind: "http",
      method: "POST",
      publicPath: "/paid/summary",
      upstreamUrl: `${upstreamUrl}/summary`,
      headers: { presets: ["api-auth"] },
    },
    {
      ...base,
      id: "priced",
      kind: "http",
      method: "POST",
      publicPath: "/paid/priced",
      upstreamUrl: `${upstreamUrl}/summary`,
      pricing: { amount: "0.02", network: NETWORK, payTo: "0xPayee", asset: "0xAsset", decimals: 6 },
    },
    {
      ...base,
      id: "chat",
      kind: "http-stream",
      method: "POST",
      publicPath: "/paid/chat",
      upstreamUrl: `${upstreamUrl}/chat`,
      headers: { presets: ["api-auth", "streaming"] },
      stream: { leasePath: "/paid/chat/lease", leaseSeconds: 60, allowRenewal: false, renewalWindowSeconds: 0 },
    },
    {
      ...base,
      id: "feed",
      kind: "websocket",
      method: "GET",
      publicPath: "/ws/feed",
      upstreamUrl: "wss://upstream.test/feed",
      stream: { leasePath: "/paid/feed/lease", leaseSeconds: 60, allowRenewal: false, renewalWindowSeconds: 0 },
    },
  ];
}

describe("runtime payment, lease and audit paths", () => {
  const controls: FacilitatorControls = { settleSucceeds: true, networks: [NETWORK] };
  const events = new InMemoryX402AccessEventStore();
  let facilitator: RunningServer;
  let upstream: RunningServer;
  let proxy: RunningServer;

  beforeAll(async () => {
    facilitator = await startExpressServer(createFacilitatorApp(controls));

    const upstreamApp = express();
    upstreamApp.use(express.json());
    upstreamApp.post("/summary", (_req, res) => res.json({ ok: true }));
    upstreamApp.post("/chat", (_req, res) => {
      res.setHeader("content-type", "text/event-stream");
      res.write("data: one\n\n");
      res.end();
    });
    upstream = await startExpressServer(upstreamApp);

    const config: X402ProxySdkConfig = {
      defaultNetwork: NETWORK,
      defaultPayTo: "0xPayee",
      leaseTokenSecret: "lease-token-secret-with-32-characters",
      facilitator: { url: facilitator.url },
      syncFacilitatorOnStart: true,
      security: { allowInsecureHttpUpstream: true, allowPrivateIpUpstreams: true },
      accessEventStore: events,
      resourceStore: new InMemoryX402ResourceStore(resources(upstream.url)),
    };
    const sdk = createX402ProxySdk(config);
    await sdk.refreshResources();
    const app = express();
    sdk.install(app);
    proxy = await startExpressServer(app);
  });

  afterAll(async () => {
    await Promise.all([proxy.close(), facilitator.close(), upstream.close()]);
  });

  async function pay(url: string, method: "GET" | "POST"): Promise<Response> {
    const { paymentRequired, accepted } = await readPaymentRequirement(url, method);
    return fetch(url, {
      method,
      headers: { "PAYMENT-SIGNATURE": buildPaymentHeader(paymentRequired, accepted) },
    });
  }

  it("settles a paid HTTP request and records a settled event with transaction + payer", async () => {
    const response = await pay(`${proxy.url}/paid/summary`, "POST");
    expect(response.status).toBe(200);
    expect(response.headers.get("payment-response")).toBeTruthy();
    const settled = events.events.find((event) => event.kind === "settled");
    expect(settled?.transaction).toBe("0xsettled");
    expect(settled?.statusCode).toBe(200);
  });

  it("returns 402 when settlement fails", async () => {
    controls.settleSucceeds = false;
    const response = await pay(`${proxy.url}/paid/summary`, "POST");
    controls.settleSucceeds = true;
    expect(response.status).toBe(402);
    expect((await response.json()) as { error: string }).toEqual({
      error: "Settlement failed",
      details: "insufficient_funds",
    });
    expect(events.events.some((event) => event.kind === "settlement_failed")).toBe(true);
  });

  it("loads a currency-override resource and challenges it", async () => {
    const response = await fetch(`${proxy.url}/paid/priced`, { method: "POST" });
    expect(response.status).toBe(402);
  });

  it("issues and consumes an HTTP-stream lease exactly once", async () => {
    const leaseResponse = await pay(`${proxy.url}/paid/chat/lease`, "POST");
    expect(leaseResponse.status).toBe(200);
    const lease = (await leaseResponse.json()) as { streamUrl: string };
    expect(events.events.some((event) => event.kind === "lease_issued")).toBe(true);

    const streamResponse = await fetch(lease.streamUrl, { method: "POST" });
    expect(streamResponse.status).toBe(200);
    expect(await streamResponse.text()).toContain("data: one");

    const replay = await fetch(lease.streamUrl, { method: "POST" });
    expect(replay.status).toBe(401);
  });

  it("rejects an HTTP-stream request with a missing or invalid lease token", async () => {
    const missing = await fetch(`${proxy.url}/paid/chat`, { method: "POST" });
    expect(missing.status).toBe(401);
    expect((await missing.json()) as { error: string }).toMatchObject({ error: "Missing x402 lease token" });
    expect(events.events.some((event) => event.errorCode === "missing_lease_token")).toBe(true);

    const invalid = await fetch(`${proxy.url}/paid/chat?t=not-a-valid-token`, { method: "POST" });
    expect(invalid.status).toBe(401);
    expect((await invalid.json()) as { error: string }).toMatchObject({ error: "Invalid x402 lease token" });
  });

  it("issues a websocket lease and returns 426 on the ws path", async () => {
    const leaseResponse = await pay(`${proxy.url}/paid/feed/lease`, "POST");
    expect(leaseResponse.status).toBe(200);
    const lease = (await leaseResponse.json()) as { wsUrl: string; leaseSeconds: number };
    expect(lease.wsUrl).toContain("/ws/feed?t=");
    expect(lease.leaseSeconds).toBe(60);

    const upgrade = await fetch(`${proxy.url}/ws/feed`);
    expect(upgrade.status).toBe(426);
  });

  it("passes unmatched routes through to the host app", async () => {
    const response = await fetch(`${proxy.url}/not-a-paid-route`);
    expect(response.status).toBe(404);
  });

  it("exposes diagnostics including the facilitator url", async () => {
    const response = await fetch(`${proxy.url}/x402/diagnostics`);
    expect(response.status).toBe(200);
    const diagnostics = (await response.json()) as {
      loadedResourceCount: number;
      facilitatorUrl: string;
      lastRefreshAt: number;
      enabledNetworks: string[];
    };
    expect(diagnostics.loadedResourceCount).toBe(4);
    expect(diagnostics.facilitatorUrl).toBe(facilitator.url);
    expect(diagnostics.lastRefreshAt).toBeGreaterThan(0);
    expect(diagnostics.enabledNetworks).toContain(NETWORK);
  });
});

describe("runtime resilience and security", () => {
  let facilitator: RunningServer;
  let upstream: RunningServer;

  beforeAll(async () => {
    facilitator = await startExpressServer(
      createFacilitatorApp({ settleSucceeds: true, networks: [NETWORK] }),
    );
    const upstreamApp = express();
    upstreamApp.use(express.json());
    upstreamApp.post("/summary", (_req, res) => res.json({ ok: true }));
    upstream = await startExpressServer(upstreamApp);
  });

  afterAll(async () => {
    await Promise.all([facilitator.close(), upstream.close()]);
  });

  it("treats audit-store failures as non-fatal", async () => {
    const throwingStore: X402AccessEventStore = {
      record: async (_event: X402AccessEvent): Promise<void> => {
        throw new Error("audit down");
      },
    };
    const sdk = createX402ProxySdk({
      defaultNetwork: NETWORK,
      defaultPayTo: "0xPayee",
      leaseTokenSecret: "lease-token-secret-with-32-characters",
      facilitator: { url: facilitator.url },
      security: { allowInsecureHttpUpstream: true, allowPrivateIpUpstreams: true },
      accessEventStore: throwingStore,
      resourceStore: new InMemoryX402ResourceStore([
        {
          id: "summary",
          enabled: true,
          kind: "http",
          method: "POST",
          publicPath: "/paid/summary",
          upstreamUrl: `${upstream.url}/summary`,
          pricing: { amount: "0.01", network: NETWORK, payTo: "0xPayee" },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]),
    });
    await sdk.refreshResources();
    const app = express();
    sdk.install(app);
    const server = await startExpressServer(app);
    try {
      const { paymentRequired, accepted } = await readPaymentRequirement(`${server.url}/paid/summary`, "POST");
      const response = await fetch(`${server.url}/paid/summary`, {
        method: "POST",
        headers: { "PAYMENT-SIGNATURE": buildPaymentHeader(paymentRequired, accepted) },
      });
      expect(response.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("returns 403 when the proxied upstream resolves to a private address", async () => {
    const sdk = createX402ProxySdk({
      defaultNetwork: NETWORK,
      defaultPayTo: "0xPayee",
      leaseTokenSecret: "lease-token-secret-with-32-characters",
      facilitator: { url: facilitator.url },
      security: { allowInsecureHttpUpstream: true, allowPrivateIpUpstreams: false },
      resourceStore: new InMemoryX402ResourceStore([
        {
          id: "private",
          enabled: true,
          kind: "http",
          method: "POST",
          publicPath: "/paid/private",
          upstreamUrl: "https://10.0.0.1/x",
          pricing: { amount: "0.01", network: NETWORK, payTo: "0xPayee" },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ]),
    });
    await sdk.refreshResources();
    const app = express();
    sdk.install(app);
    const server = await startExpressServer(app);
    try {
      const { paymentRequired, accepted } = await readPaymentRequirement(`${server.url}/paid/private`, "POST");
      const response = await fetch(`${server.url}/paid/private`, {
        method: "POST",
        headers: { "PAYMENT-SIGNATURE": buildPaymentHeader(paymentRequired, accepted) },
      });
      expect(response.status).toBe(403);
      expect((await response.json()) as { code: string }).toMatchObject({ code: "SECURITY_POLICY_ERROR" });
    } finally {
      await server.close();
    }
  });
});
