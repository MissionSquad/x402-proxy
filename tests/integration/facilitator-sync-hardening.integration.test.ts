import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createX402ProxySdk, InMemoryX402ResourceStore } from "../../src";
import type { X402ProxySdk, X402Resource } from "../../src/types";
import { readPaymentRequirement, startExpressServer, type RunningServer } from "../helpers/x402";

/**
 * Facilitator-sync hardening:
 * - a resource on a network the facilitator does not support is pruned to the invalid
 *   list instead of poisoning every paid route;
 * - a failed sync (facilitator down) fails payment requests with a retryable 503,
 *   surfaces in diagnostics, and recovers on the next request once the facilitator is
 *   back — with no unhandled promise rejection at any point.
 */
describe("facilitator sync hardening integration", () => {
  let facilitatorServer: RunningServer;
  let proxyServer: RunningServer;
  let sdk: X402ProxySdk;
  const state = { down: false };
  const GOOD_NETWORK = "eip155:8453";
  const unhandled: unknown[] = [];
  const collect = (reason: unknown): void => {
    unhandled.push(reason);
  };

  beforeAll(async () => {
    process.on("unhandledRejection", collect);

    const facilitatorApp = express();
    facilitatorApp.use(express.json());
    facilitatorApp.get("/supported", (_req, res) => {
      if (state.down) {
        res.status(500).json({ error: "facilitator down" });
        return;
      }
      res.json({ kinds: [{ x402Version: 2, scheme: "exact", network: GOOD_NETWORK }], extensions: [], signers: {} });
    });
    facilitatorApp.post("/verify", (_req, res) => {
      res.json({ isValid: true, payer: "payer" });
    });
    facilitatorApp.post("/settle", (_req, res) => {
      res.json({ success: true, transaction: "0xsettled", network: GOOD_NETWORK });
    });
    facilitatorServer = await startExpressServer(facilitatorApp);

    const now = Date.now();
    const good: X402Resource = {
      id: "good-agent",
      enabled: true,
      kind: "http-stream-direct",
      method: "POST",
      publicPath: "/v1/chat/completions",
      match: { bodyField: "model", equals: "alice/good-agent" },
      upstreamUrl: "http://127.0.0.1:9/never-called",
      pricing: { amount: "0.01", network: GOOD_NETWORK, payTo: "0xGood" },
      createdAt: now,
      updatedAt: now,
    };
    const badNetwork: X402Resource = {
      id: "bad-network-agent",
      enabled: true,
      kind: "http",
      method: "POST",
      publicPath: "/paid/bad-network",
      upstreamUrl: "http://127.0.0.1:9/never-called",
      pricing: { amount: "0.01", network: "solana:Fake111", payTo: "SoLPayee11111111111111111111111111111111111" },
      createdAt: now,
      updatedAt: now,
    };

    const app = express();
    app.use(express.json());
    sdk = createX402ProxySdk({
      defaultNetwork: GOOD_NETWORK,
      defaultPayTo: "0xDefault",
      leaseTokenSecret: "lease-token-secret-with-32-characters",
      facilitator: { url: facilitatorServer.url },
      syncFacilitatorOnStart: true,
      security: { allowInsecureHttpUpstream: true, allowPrivateIpUpstreams: true },
      resourceStore: new InMemoryX402ResourceStore([good, badNetwork]),
    });
    await sdk.refreshResources();
    sdk.install(app);
    app.use((_req, res) => {
      res.status(404).json({ marker: "app-404" });
    });
    proxyServer = await startExpressServer(app);
  });

  afterAll(async () => {
    process.off("unhandledRejection", collect);
    await Promise.all([proxyServer.close(), facilitatorServer.close()]);
  });

  function goodChatInit() {
    return {
      body: JSON.stringify({ model: "alice/good-agent", messages: [], stream: true }),
      headers: { "content-type": "application/json" },
    };
  }

  it("prunes the unsupported-network resource and keeps serving the rest", async () => {
    // Both resources load; the facilitator only supports the good network.
    expect(sdk.diagnostics().loadedResourceCount).toBe(2);

    // First payment request triggers the sync, which prunes the unsupported route and
    // then answers the good resource's challenge normally.
    const { accepted } = await readPaymentRequirement(
      `${proxyServer.url}/v1/chat/completions`,
      "POST",
      goodChatInit(),
    );
    expect(accepted.network).toBe(GOOD_NETWORK);

    const diagnostics = sdk.diagnostics();
    expect(diagnostics.loadedResourceCount).toBe(1);
    expect(diagnostics.invalidResources.some((issue) => issue.resourceId === "bad-network-agent")).toBe(true);

    // The pruned resource's path no longer matches anything.
    const pruned = await fetch(`${proxyServer.url}/paid/bad-network`, { method: "POST" });
    expect(pruned.status).toBe(404);
    expect(await pruned.json()).toEqual({ marker: "app-404" });
  });

  it("fails 503 while the facilitator is down and recovers on the next request", async () => {
    state.down = true;
    await sdk.refreshResources(); // rebuild: schedules a sync that will fail

    const failed = await fetch(`${proxyServer.url}/v1/chat/completions`, { method: "POST", ...goodChatInit() });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ code: "FACILITATOR_SYNC_ERROR" });
    expect(sdk.diagnostics().facilitatorSyncError).toBeTruthy();

    state.down = false;
    // Same request again: the sync retries, prunes the still-unsupported resource, and
    // the challenge succeeds. The sync error clears from diagnostics.
    const { accepted } = await readPaymentRequirement(
      `${proxyServer.url}/v1/chat/completions`,
      "POST",
      goodChatInit(),
    );
    expect(accepted.network).toBe(GOOD_NETWORK);
    expect(sdk.diagnostics().facilitatorSyncError).toBeUndefined();
  });

  it("never leaks an unhandled rejection from a failed background sync", async () => {
    state.down = true;
    await sdk.refreshResources();
    // Give the failed sync time to reject with no payment request awaiting it.
    await new Promise((resolve) => setTimeout(resolve, 100));
    state.down = false;
    expect(unhandled).toEqual([]);
  });
});
