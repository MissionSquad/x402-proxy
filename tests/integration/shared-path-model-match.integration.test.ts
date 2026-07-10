import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createX402ProxySdk, InMemoryX402ResourceStore } from "../../src";
import type { X402Resource } from "../../src/types";
import {
  buildPaymentHeader,
  readPaymentRequirement,
  startExpressServer,
  type RunningServer,
} from "../helpers/x402";

/**
 * OpenAI-compatible shared path: many http-stream-direct resources share ONE
 * publicPath (/v1/chat/completions) and are selected by the request body's `model`
 * field, each carrying its own price/payTo. Payment settles on the request itself
 * (no lease), then the upstream response is piped.
 */
describe("shared-path body-match integration", () => {
  let facilitatorServer: RunningServer;
  let upstreamServer: RunningServer;
  let proxyServer: RunningServer;
  const order: string[] = [];
  const upstreamHits: Array<{ body: Record<string, unknown>; apiKey: string | null }> = [];

  const NETWORK = "eip155:8453";

  function resource(id: string, model: string, price: string, payTo: string): X402Resource {
    const now = Date.now();
    return {
      id,
      enabled: true,
      kind: "http-stream-direct",
      method: "POST",
      publicPath: "/v1/chat/completions",
      match: { bodyField: "model", equals: model },
      upstreamUrl: `${upstreamServer.url}/v1/chat/completions`,
      pricing: { amount: price, network: NETWORK, payTo },
      headers: {
        presets: ["streaming"],
        addRequestHeaders: { "content-type": "application/json" },
      },
      access: {
        mode: "service-token",
        serviceTokenHeader: "x-api-key",
        serviceTokenValue: "msq-service-key",
      },
      createdAt: now,
      updatedAt: now,
    };
  }

  beforeAll(async () => {
    const facilitatorApp = express();
    facilitatorApp.use(express.json());
    facilitatorApp.get("/supported", (_req, res) => {
      res.json({ kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: [], signers: {} });
    });
    facilitatorApp.post("/verify", (_req, res) => {
      res.json({ isValid: true, payer: "payer" });
    });
    facilitatorApp.post("/settle", (_req, res) => {
      order.push("settle");
      res.json({ success: true, transaction: "0xsettled", network: NETWORK });
    });
    facilitatorServer = await startExpressServer(facilitatorApp);

    const upstreamApp = express();
    upstreamApp.use(express.json());
    upstreamApp.post("/v1/chat/completions", (req, res) => {
      order.push("upstream");
      upstreamHits.push({
        body: req.body as Record<string, unknown>,
        apiKey: req.get("x-api-key") ?? null,
      });
      const body = req.body as { model?: string; stream?: boolean };
      if (body.stream === true) {
        res.setHeader("content-type", "text/event-stream");
        res.setHeader("cache-control", "no-cache");
        res.write(`data: {"model":"${body.model}"}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.json({ object: "chat.completion", model: body.model });
    });
    upstreamServer = await startExpressServer(upstreamApp);

    const app = express();
    app.use(express.json());
    const sdk = createX402ProxySdk({
      defaultNetwork: NETWORK,
      defaultPayTo: "0xDefault",
      leaseTokenSecret: "lease-token-secret-with-32-characters",
      facilitator: { url: facilitatorServer.url },
      syncFacilitatorOnStart: true,
      security: { allowInsecureHttpUpstream: true, allowPrivateIpUpstreams: true },
      resourceStore: new InMemoryX402ResourceStore([
        resource("agent-a", "alice/agent-a", "0.01", "0xAAA0000000000000000000000000000000000001"),
        resource("agent-b", "bob/agent-b", "0.02", "0xBBB0000000000000000000000000000000000002"),
      ]),
    });
    await sdk.refreshResources();
    sdk.install(app);
    app.use((_req, res) => {
      res.status(404).json({ marker: "app-404" });
    });
    proxyServer = await startExpressServer(app);
  });

  afterAll(async () => {
    await Promise.all([proxyServer.close(), facilitatorServer.close(), upstreamServer.close()]);
  });

  function chatInit(model: string, stream: boolean, extraHeaders: Record<string, string> = {}) {
    return {
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], stream }),
      headers: { "content-type": "application/json", ...extraHeaders },
    };
  }

  it("prices the 402 challenge per matched model and advertises the real URL", async () => {
    const url = `${proxyServer.url}/v1/chat/completions`;
    const a = await readPaymentRequirement(url, "POST", chatInit("alice/agent-a", true));
    const b = await readPaymentRequirement(url, "POST", chatInit("bob/agent-b", true));

    expect(a.accepted.payTo).toBe("0xAAA0000000000000000000000000000000000001");
    expect(b.accepted.payTo).toBe("0xBBB0000000000000000000000000000000000002");
    expect(a.accepted.amount).not.toBe(b.accepted.amount);
    // The challenge must advertise the real endpoint, never the synthetic route key.
    expect(a.paymentRequired.resource.url).toContain("/v1/chat/completions");
    expect(a.paymentRequired.resource.url).not.toContain("__x402");
  });

  it("falls through to the host app for unknown models and missing bodies", async () => {
    const url = `${proxyServer.url}/v1/chat/completions`;
    const unknown = await fetch(url, { method: "POST", ...chatInit("nobody/none", true) });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ marker: "app-404" });

    const noBody = await fetch(url, { method: "POST" });
    expect(noBody.status).toBe(404);
    expect(await noBody.json()).toEqual({ marker: "app-404" });
  });

  it("settles before the upstream call, injects the service token, and pipes SSE", async () => {
    order.length = 0;
    const url = `${proxyServer.url}/v1/chat/completions`;
    const { paymentRequired, accepted } = await readPaymentRequirement(url, "POST", chatInit("alice/agent-a", true));
    const response = await fetch(url, {
      method: "POST",
      ...chatInit("alice/agent-a", true, {
        "PAYMENT-SIGNATURE": buildPaymentHeader(paymentRequired, accepted),
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("payment-response")).toBeTruthy();
    const text = await response.text();
    expect(text).toContain('data: {"model":"alice/agent-a"}');
    expect(text).toContain("data: [DONE]");
    expect(order).toEqual(["settle", "upstream"]);
    expect(upstreamHits.at(-1)).toMatchObject({ apiKey: "msq-service-key" });
    expect(upstreamHits.at(-1)?.body).toMatchObject({ model: "alice/agent-a", stream: true });
  });

  it("relays buffered (stream:false) completions through the same resource", async () => {
    const url = `${proxyServer.url}/v1/chat/completions`;
    const { paymentRequired, accepted } = await readPaymentRequirement(url, "POST", chatInit("bob/agent-b", false));
    const response = await fetch(url, {
      method: "POST",
      ...chatInit("bob/agent-b", false, {
        "PAYMENT-SIGNATURE": buildPaymentHeader(paymentRequired, accepted),
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("payment-response")).toBeTruthy();
    expect(await response.json()).toEqual({ object: "chat.completion", model: "bob/agent-b" });
  });

  it("rejects duplicate discriminator claims at refresh (custom store path)", async () => {
    // A custom store (e.g. Mongo-backed) is not pre-validated like the in-memory one,
    // so the runtime's own refresh-time guard must catch colliding claims.
    const duplicates = [
      resource("dup-1", "same/model", "0.01", "0xAAA0000000000000000000000000000000000001"),
      resource("dup-2", "same/model", "0.02", "0xBBB0000000000000000000000000000000000002"),
    ];
    const sdk = createX402ProxySdk({
      defaultNetwork: NETWORK,
      defaultPayTo: "0xDefault",
      leaseTokenSecret: "lease-token-secret-with-32-characters",
      facilitator: { url: facilitatorServer.url },
      syncFacilitatorOnStart: false,
      resourceStore: {
        listEnabledResources: async () => duplicates,
        getResourceById: async (id) => duplicates.find((r) => r.id === id) ?? null,
        getResourceForRequest: async () => null,
      },
    });
    const result = await sdk.refreshResources();
    expect(result.loaded.map((r) => r.id)).toEqual(["dup-1"]);
    expect(result.invalid).toHaveLength(1);
    expect(result.invalid[0]?.reason).toContain("duplicate payment route");
    expect(result.invalid[0]?.reason).toContain("model=same/model");
  });

  it("rejects duplicate discriminator claims in the in-memory store", () => {
    expect(
      () =>
        new InMemoryX402ResourceStore([
          resource("dup-1", "same/model", "0.01", "0xAAA0000000000000000000000000000000000001"),
          resource("dup-2", "same/model", "0.02", "0xBBB0000000000000000000000000000000000002"),
        ]),
    ).toThrowError(/Duplicate resource route/);
  });
});
