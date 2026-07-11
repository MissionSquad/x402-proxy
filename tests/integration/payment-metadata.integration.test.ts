import type { PaymentRequirements } from "@x402/core/types";
import express, { type Request, type Response as ExpressResponse } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createHttpStreamLeaseToken, createX402ProxySdk, InMemoryX402ResourceStore } from "../../src";
import type { X402PaymentSettledEvent, X402Resource } from "../../src/types";
import {
  buildPaymentHeader,
  createFacilitatorApp,
  readPaymentRequirement,
  startExpressServer,
  type FacilitatorControls,
  type RunningServer,
} from "../helpers/x402";

const NETWORK = "eip155:8453";
const SETTLE_PAYER = "0xPayerAddress00000000000000000000000000001";
const SETTLE_TRANSACTION = "0xsettled";
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Metadata header names asserted throughout (mirrors PAYMENT_METADATA_HEADERS). */
const METADATA_HEADER_NAMES = [
  "x-x402-payment-id",
  "x-x402-resource-id",
  "x-x402-scheme",
  "x-x402-network",
  "x-x402-amount",
  "x-x402-asset",
  "x-x402-pay-to",
  "x-x402-payer",
  "x-x402-transaction",
] as const;

type UpstreamHit = { path: string; headers: Record<string, string | string[] | undefined> };

describe("payment metadata forwarding integration", () => {
  const controls: FacilitatorControls = { settleSucceeds: true, networks: [NETWORK] };
  const order: string[] = [];
  const upstreamHits: UpstreamHit[] = [];
  const settledEvents: X402PaymentSettledEvent[] = [];
  const callbackBehavior: { mode: "none" | "sync-throw" | "reject" } = { mode: "none" };

  let facilitatorServer: RunningServer;
  let upstreamServer: RunningServer;
  let proxyServer: RunningServer;

  function resource(overrides: Partial<X402Resource> & Pick<X402Resource, "id" | "kind" | "publicPath" | "upstreamUrl">): X402Resource {
    const now = Date.now();
    return {
      enabled: true,
      method: "POST",
      pricing: { amount: "0.01", network: NETWORK, payTo: "0xPayee0000000000000000000000000000000001" },
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  beforeAll(async () => {
    // Wrap the shared facilitator helper so settle calls land in the order log.
    const facilitatorApp = express();
    facilitatorApp.use((req, _res, next) => {
      if (req.method === "POST" && req.path === "/settle") {
        order.push("settle");
      }
      next();
    });
    facilitatorApp.use(createFacilitatorApp(controls));
    facilitatorServer = await startExpressServer(facilitatorApp);

    const upstreamApp = express();
    const capture = (req: Request, res: ExpressResponse): void => {
      order.push("upstream");
      upstreamHits.push({ path: req.path, headers: { ...req.headers } });
      res.json({ ok: true, path: req.path });
    };
    upstreamApp.post("/alpha", capture);
    upstreamApp.post("/direct", capture);
    upstreamApp.post("/spoof", capture);
    upstreamApp.post("/chat", (req, res) => {
      order.push("upstream");
      upstreamHits.push({ path: req.path, headers: { ...req.headers } });
      res.setHeader("content-type", "text/event-stream");
      res.write("data: one\n\n");
      res.end();
    });
    upstreamServer = await startExpressServer(upstreamApp);

    const sdk = createX402ProxySdk({
      defaultNetwork: NETWORK,
      defaultPayTo: "0xPayee0000000000000000000000000000000001",
      leaseTokenSecret: "lease-token-secret-with-32-characters",
      facilitator: { url: facilitatorServer.url },
      syncFacilitatorOnStart: true,
      security: { allowInsecureHttpUpstream: true, allowPrivateIpUpstreams: true },
      onPaymentSettled: (event) => {
        settledEvents.push(event);
        if (callbackBehavior.mode === "sync-throw") {
          throw new Error("host callback exploded synchronously");
        }
        if (callbackBehavior.mode === "reject") {
          return Promise.reject(new Error("host callback rejected"));
        }
        return undefined;
      },
      resourceStore: new InMemoryX402ResourceStore([
        // Path-hostile id proves the encodeURIComponent contract for x-x402-resource-id.
        resource({
          id: "agents/alpha beta",
          kind: "http",
          publicPath: "/paid/alpha",
          upstreamUrl: `${upstreamServer.url}/alpha`,
        }),
        resource({
          id: "direct-agent",
          kind: "http-stream-direct",
          publicPath: "/paid/direct",
          upstreamUrl: `${upstreamServer.url}/direct`,
        }),
        resource({
          id: "stream-agent",
          kind: "http-stream",
          publicPath: "/paid/chat",
          upstreamUrl: `${upstreamServer.url}/chat`,
          stream: { leasePath: "/paid/chat/lease", leaseSeconds: 60, allowRenewal: false, renewalWindowSeconds: 0 },
        }),
        // Explicitly allow-lists the metadata names: spoofed client values must STILL
        // never reach the upstream.
        resource({
          id: "spoof-agent",
          kind: "http",
          publicPath: "/paid/spoof",
          upstreamUrl: `${upstreamServer.url}/spoof`,
          headers: {
            forwardRequestHeaders: ["x-x402-payment-id", "x-x402-payer", "x-x402-transaction"],
          },
        }),
        // WebSocket resource: settlement (and therefore onPaymentSettled) happens on the
        // lease POST, before any socket exists. The upstream ws URL is only embedded in the
        // lease token, never dialed, so no upstream route is needed.
        resource({
          id: "ws-agent",
          kind: "websocket",
          method: "GET",
          publicPath: "/ws/feed",
          upstreamUrl: "wss://upstream.test/feed",
          stream: { leasePath: "/paid/feed/lease", leaseSeconds: 60, allowRenewal: false, renewalWindowSeconds: 0 },
        }),
      ]),
    });
    await sdk.refreshResources();
    const app = express();
    sdk.install(app);
    proxyServer = await startExpressServer(app);
  });

  afterAll(async () => {
    await Promise.all([proxyServer.close(), facilitatorServer.close(), upstreamServer.close()]);
  });

  async function pay(url: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
    const { paymentRequired, accepted } = await readPaymentRequirement(url, "POST");
    return fetch(url, {
      method: "POST",
      headers: { "PAYMENT-SIGNATURE": buildPaymentHeader(paymentRequired, accepted), ...extraHeaders },
    });
  }

  function resetLogs(): void {
    order.length = 0;
    upstreamHits.length = 0;
    settledEvents.length = 0;
  }

  it("forwards trusted metadata (no payer/tx) for kind http and notifies the host on settle", async () => {
    resetLogs();
    const url = `${proxyServer.url}/paid/alpha`;
    const { accepted } = await readPaymentRequirement(url, "POST");
    const response = await pay(url);
    expect(response.status).toBe(200);

    const hit = upstreamHits.at(-1);
    expect(hit?.path).toBe("/alpha");
    const headers = hit?.headers ?? {};
    expect(headers["x-x402-payment-id"]).toMatch(UUID_REGEX);
    expect(headers["x-x402-resource-id"]).toBe("agents%2Falpha%20beta");
    expect(headers["x-x402-scheme"]).toBe(accepted.scheme);
    expect(headers["x-x402-network"]).toBe(NETWORK);
    expect(headers["x-x402-amount"]).toBe(accepted.amount);
    expect(headers["x-x402-asset"]).toBe(accepted.asset);
    expect(headers["x-x402-pay-to"]).toBe(accepted.payTo);
    // Settlement is post-request for kind http: never present on the upstream call.
    expect(headers["x-x402-payer"]).toBeUndefined();
    expect(headers["x-x402-transaction"]).toBeUndefined();

    expect(settledEvents).toHaveLength(1);
    const event = settledEvents[0];
    expect(event?.paymentId).toBe(headers["x-x402-payment-id"]);
    expect(event?.resourceId).toBe("agents/alpha beta");
    expect(event?.kind).toBe("http");
    expect(event?.transaction).toBe(SETTLE_TRANSACTION);
    expect(event?.network).toBe(NETWORK);
    expect(event?.payer).toBe(SETTLE_PAYER);
    expect(event?.requirements).toEqual({
      scheme: accepted.scheme,
      network: accepted.network,
      amount: accepted.amount,
      asset: accepted.asset,
      payTo: accepted.payTo,
    });
    expect(event?.settledAt).toBeGreaterThan(0);
  });

  it("forwards the SERVER requirement, not a tampered x402 v1 client `accepted`, on kind http", async () => {
    // F1 anti-spoof: an x402 v1 payment is matched by scheme+network ONLY (never
    // deep-equal-checked against the server's accepts), so a client can echo back an
    // `accepted` that keeps the real scheme+network but forges amount/asset/payTo. The
    // mocked facilitator /verify returns isValid:true without inspecting the payload, so
    // the forged payment verifies — the SDK must still source upstream metadata (and the
    // settled event) from `payment.paymentRequirements` (the server-matched requirement).
    resetLogs();
    const url = `${proxyServer.url}/paid/alpha`;
    const { paymentRequired, accepted } = await readPaymentRequirement(url, "POST");

    const tampered: PaymentRequirements = {
      ...accepted,
      amount: "0",
      asset: "0xATTACKERasset000000000000000000000000dEaD",
      payTo: "0xATTACKERpayout00000000000000000000000dEaD",
    };
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "PAYMENT-SIGNATURE": buildPaymentHeader({ ...paymentRequired, x402Version: 1 }, tampered),
      },
    });
    expect(response.status).toBe(200);

    const hit = upstreamHits.at(-1);
    expect(hit?.path).toBe("/alpha");
    const headers = hit?.headers ?? {};
    // Server values win: the forged amount/asset/payTo never reach the upstream.
    expect(headers["x-x402-scheme"]).toBe(accepted.scheme);
    expect(headers["x-x402-network"]).toBe(NETWORK);
    expect(headers["x-x402-amount"]).toBe(accepted.amount);
    expect(headers["x-x402-amount"]).not.toBe("0");
    expect(headers["x-x402-asset"]).toBe(accepted.asset);
    expect(headers["x-x402-asset"]).not.toBe(tampered.asset);
    expect(headers["x-x402-pay-to"]).toBe(accepted.payTo);
    expect(headers["x-x402-pay-to"]).not.toBe(tampered.payTo);

    // The settled-event requirements mirror the server values too, never the forgery.
    expect(settledEvents).toHaveLength(1);
    expect(settledEvents[0]?.requirements).toEqual({
      scheme: accepted.scheme,
      network: accepted.network,
      amount: accepted.amount,
      asset: accepted.asset,
      payTo: accepted.payTo,
    });
  });

  it("forwards trusted metadata for http-stream-direct and preserves upstream-then-settle ordering", async () => {
    resetLogs();
    const url = `${proxyServer.url}/paid/direct`;
    const { accepted } = await readPaymentRequirement(url, "POST");
    const response = await pay(url);
    expect(response.status).toBe(200);
    await response.text();

    // Existing contract: connect upstream first, settle only after it accepts.
    expect(order).toEqual(["upstream", "settle"]);

    const headers = upstreamHits.at(-1)?.headers ?? {};
    expect(headers["x-x402-payment-id"]).toMatch(UUID_REGEX);
    expect(headers["x-x402-resource-id"]).toBe("direct-agent");
    expect(headers["x-x402-scheme"]).toBe(accepted.scheme);
    expect(headers["x-x402-network"]).toBe(NETWORK);
    expect(headers["x-x402-amount"]).toBe(accepted.amount);
    expect(headers["x-x402-asset"]).toBe(accepted.asset);
    expect(headers["x-x402-pay-to"]).toBe(accepted.payTo);
    expect(headers["x-x402-payer"]).toBeUndefined();
    expect(headers["x-x402-transaction"]).toBeUndefined();

    expect(settledEvents).toHaveLength(1);
    expect(settledEvents[0]?.kind).toBe("http-stream-direct");
    expect(settledEvents[0]?.paymentId).toBe(headers["x-x402-payment-id"]);
    expect(settledEvents[0]?.transaction).toBe(SETTLE_TRANSACTION);
    expect(settledEvents[0]?.payer).toBe(SETTLE_PAYER);
  });

  it("never lets spoofed client x-x402-* values reach the upstream, even when allow-listed", async () => {
    resetLogs();
    const url = `${proxyServer.url}/paid/spoof`;
    const response = await pay(url, {
      "x-x402-payment-id": "spoofed-payment-id",
      "x-x402-payer": "0xEvilPayer",
      "x-x402-transaction": "0xForgedTx",
    });
    expect(response.status).toBe(200);

    const headers = upstreamHits.at(-1)?.headers ?? {};
    // SDK value wins: a fresh UUID, never the spoofed string.
    expect(headers["x-x402-payment-id"]).toMatch(UUID_REGEX);
    expect(headers["x-x402-payment-id"]).not.toBe("spoofed-payment-id");
    // Not set by the SDK for kind http, and the client values must be stripped.
    expect(headers["x-x402-payer"]).toBeUndefined();
    expect(headers["x-x402-transaction"]).toBeUndefined();
  });

  it("relays the full metadata set, payer and transaction included, on the http-stream lease flow", async () => {
    resetLogs();
    const leaseUrl = `${proxyServer.url}/paid/chat/lease`;
    const { accepted } = await readPaymentRequirement(leaseUrl, "POST");
    const leaseResponse = await pay(leaseUrl);
    expect(leaseResponse.status).toBe(200);
    const lease = (await leaseResponse.json()) as { streamUrl: string };

    // Lease issuance settles once (before any upstream contact) and notifies the host.
    expect(order).toEqual(["settle"]);
    expect(settledEvents).toHaveLength(1);
    expect(settledEvents[0]?.kind).toBe("http-stream");
    expect(settledEvents[0]?.resourceId).toBe("stream-agent");

    const streamResponse = await fetch(lease.streamUrl, { method: "POST" });
    expect(streamResponse.status).toBe(200);
    expect(await streamResponse.text()).toContain("data: one");
    expect(order).toEqual(["settle", "upstream"]);

    const headers = upstreamHits.at(-1)?.headers ?? {};
    expect(headers["x-x402-payment-id"]).toBe(settledEvents[0]?.paymentId);
    expect(headers["x-x402-resource-id"]).toBe("stream-agent");
    expect(headers["x-x402-scheme"]).toBe(accepted.scheme);
    expect(headers["x-x402-network"]).toBe(NETWORK);
    expect(headers["x-x402-amount"]).toBe(accepted.amount);
    expect(headers["x-x402-asset"]).toBe(accepted.asset);
    expect(headers["x-x402-pay-to"]).toBe(accepted.payTo);
    // Settlement happened at lease issuance, so the relay carries the settle results.
    expect(headers["x-x402-payer"]).toBe(SETTLE_PAYER);
    expect(headers["x-x402-transaction"]).toBe(SETTLE_TRANSACTION);
    // The relay must not fire a second settlement or a second event.
    expect(settledEvents).toHaveLength(1);
  });

  it("fires onPaymentSettled with kind websocket on the websocket lease path", async () => {
    resetLogs();
    const leaseUrl = `${proxyServer.url}/paid/feed/lease`;
    const { accepted } = await readPaymentRequirement(leaseUrl, "POST");
    const response = await pay(leaseUrl);
    expect(response.status).toBe(200);
    const lease = (await response.json()) as { wsUrl: string; leaseSeconds: number };
    expect(lease.wsUrl).toContain("/ws/feed?t=");
    expect(lease.leaseSeconds).toBe(60);

    // Settlement happens at lease issuance, before (and without) any socket or upstream call.
    expect(order).toEqual(["settle"]);
    expect(settledEvents).toHaveLength(1);
    const event = settledEvents[0];
    expect(event?.kind).toBe("websocket");
    expect(event?.resourceId).toBe("ws-agent");
    expect(event?.transaction).toBe(SETTLE_TRANSACTION);
    expect(event?.network).toBe(NETWORK);
    expect(event?.payer).toBe(SETTLE_PAYER);
    expect(event?.requirements).toEqual({
      scheme: accepted.scheme,
      network: accepted.network,
      amount: accepted.amount,
      asset: accepted.asset,
      payTo: accepted.payTo,
    });
  });

  it("relays leases minted without payment fields (pre-0.2.1 tokens) with no metadata headers", async () => {
    resetLogs();
    const legacyToken = createHttpStreamLeaseToken(
      {
        resourceId: "stream-agent",
        exp: Math.floor(Date.now() / 1000) + 60,
        jti: `legacy-${Date.now()}`,
        method: "POST",
        publicPath: "/paid/chat",
        upstreamUrl: `${upstreamServer.url}/chat`,
      },
      "lease-token-secret-with-32-characters",
    );
    const response = await fetch(`${proxyServer.url}/paid/chat?t=${encodeURIComponent(legacyToken)}`, {
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("data: one");
    const headers = upstreamHits.at(-1)?.headers ?? {};
    expect(Object.keys(headers).filter((name) => name.startsWith("x-x402-"))).toEqual([]);
  });

  it("completes the paid request normally when onPaymentSettled throws or rejects", async () => {
    resetLogs();
    try {
      callbackBehavior.mode = "sync-throw";
      const throwing = await pay(`${proxyServer.url}/paid/alpha`);
      expect(throwing.status).toBe(200);
      expect(await throwing.json()).toEqual({ ok: true, path: "/alpha" });

      callbackBehavior.mode = "reject";
      const rejecting = await pay(`${proxyServer.url}/paid/alpha`);
      expect(rejecting.status).toBe(200);
      expect(await rejecting.json()).toEqual({ ok: true, path: "/alpha" });

      // The callback ran both times; its failures were swallowed, not propagated.
      expect(settledEvents).toHaveLength(2);
    } finally {
      callbackBehavior.mode = "none";
    }
  });

  it("sends zero x-x402-* headers when forwardPaymentMetadata is false, but still notifies the host", async () => {
    const events: X402PaymentSettledEvent[] = [];
    const sdk = createX402ProxySdk({
      defaultNetwork: NETWORK,
      defaultPayTo: "0xPayee0000000000000000000000000000000001",
      leaseTokenSecret: "lease-token-secret-with-32-characters",
      facilitator: { url: facilitatorServer.url },
      syncFacilitatorOnStart: true,
      security: { allowInsecureHttpUpstream: true, allowPrivateIpUpstreams: true },
      forwardPaymentMetadata: false,
      onPaymentSettled: (event) => {
        events.push(event);
      },
      resourceStore: new InMemoryX402ResourceStore([
        resource({
          id: "quiet-agent",
          kind: "http",
          publicPath: "/paid/quiet",
          upstreamUrl: `${upstreamServer.url}/alpha`,
        }),
      ]),
    });
    await sdk.refreshResources();
    const app = express();
    sdk.install(app);
    const server = await startExpressServer(app);
    try {
      resetLogs();
      const url = `${server.url}/paid/quiet`;
      const { paymentRequired, accepted } = await readPaymentRequirement(url, "POST");
      const response = await fetch(url, {
        method: "POST",
        headers: { "PAYMENT-SIGNATURE": buildPaymentHeader(paymentRequired, accepted) },
      });
      expect(response.status).toBe(200);

      const headers = upstreamHits.at(-1)?.headers ?? {};
      for (const name of METADATA_HEADER_NAMES) {
        expect(headers[name], name).toBeUndefined();
      }
      expect(Object.keys(headers).filter((name) => name.startsWith("x-x402-"))).toEqual([]);

      expect(events).toHaveLength(1);
      expect(events[0]?.resourceId).toBe("quiet-agent");
      expect(events[0]?.transaction).toBe(SETTLE_TRANSACTION);
      expect(events[0]?.payer).toBe(SETTLE_PAYER);
    } finally {
      await server.close();
    }
  });
});
