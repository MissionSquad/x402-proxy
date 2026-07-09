import { describe, expect, it, vi } from "vitest";

import {
  createDiscoveryDocument,
  createDiscoveryDocumentFromResources,
  createDiscoveryHandler,
  installDiscoveryEndpoints,
} from "../../src/discovery";
import type {
  DiscoveryConfig,
  ProxyEndpointConfig,
  X402LoadedResource,
} from "../../src/types";
import { FakeResponse } from "../helpers/fakeHttp";

const discovery: DiscoveryConfig = {
  enabled: true,
  publicBaseUrl: "https://api.example.com",
  ownershipProofs: ["proof-1"],
  instructions: "pay first",
};

const httpEndpoint: ProxyEndpointConfig = {
  kind: "http",
  id: "h",
  method: "GET",
  publicPath: "/api/x",
  upstreamUrl: "https://upstream.test/x",
  price: "0.01",
};

const wsEndpoint: ProxyEndpointConfig = {
  kind: "websocket",
  id: "w",
  leasePath: "/ws/lease",
  wsPath: "/ws/feed",
  upstreamWsUrl: "wss://upstream.test/feed",
  price: "0.02",
  leaseSeconds: 60,
};

describe("createDiscoveryDocument", () => {
  it("collects http public paths and ws lease paths with proofs/instructions", () => {
    const doc = createDiscoveryDocument(discovery, [httpEndpoint, wsEndpoint]);
    expect(doc.version).toBe(1);
    expect(doc.resources).toEqual([
      "https://api.example.com/api/x",
      "https://api.example.com/ws/lease",
    ]);
    expect(doc.ownershipProofs).toEqual(["proof-1"]);
    expect(doc.instructions).toBe("pay first");
  });

  it("omits proofs/instructions when not provided", () => {
    const doc = createDiscoveryDocument(
      { enabled: true, publicBaseUrl: "https://api.example.com" },
      [httpEndpoint],
    );
    expect(doc.ownershipProofs).toBeUndefined();
    expect(doc.instructions).toBeUndefined();
  });
});

describe("createDiscoveryDocumentFromResources", () => {
  const resource: X402LoadedResource = {
    id: "r",
    kind: "http",
    method: "GET",
    publicPath: "/api/y",
    paymentPath: "/api/y",
    upstreamUrl: "https://upstream.test/y",
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };

  it("builds resources from loaded payment paths with proofs/instructions", () => {
    const doc = createDiscoveryDocumentFromResources(discovery, [resource]);
    expect(doc.resources).toEqual(["https://api.example.com/api/y"]);
    expect(doc.ownershipProofs).toEqual(["proof-1"]);
    expect(doc.instructions).toBe("pay first");
  });

  it("omits optional fields when absent", () => {
    const doc = createDiscoveryDocumentFromResources(
      { enabled: true, publicBaseUrl: "https://api.example.com" },
      [resource],
    );
    expect(doc.ownershipProofs).toBeUndefined();
    expect(doc.instructions).toBeUndefined();
  });

  it("emits lease endpoints for http-stream and websocket resources, never raw stream paths or upstream URLs", () => {
    const streamResource: X402LoadedResource = {
      id: "s",
      kind: "http-stream",
      method: "POST",
      publicPath: "/paid/agents/[username]/[slug]/chat",
      paymentPath: "/paid/agents/[username]/[slug]/chat/lease",
      upstreamUrl: "https://upstream.test/chat",
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };
    const wsResource: X402LoadedResource = {
      id: "w",
      kind: "websocket",
      method: "GET",
      publicPath: "/ws/feed",
      paymentPath: "/ws/lease",
      upstreamUrl: "wss://upstream.test/feed",
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };

    const doc = createDiscoveryDocumentFromResources(discovery, [streamResource, wsResource]);
    expect(doc.resources).toEqual([
      "https://api.example.com/paid/agents/[username]/[slug]/chat/lease",
      "https://api.example.com/ws/lease",
    ]);
    const serialized = JSON.stringify(doc);
    expect(serialized).not.toContain("upstream.test");
    expect(serialized).not.toContain("/paid/agents/[username]/[slug]/chat\"");
    expect(serialized).not.toContain("/ws/feed");
  });
});

describe("createDiscoveryHandler", () => {
  it("uses runtime resources when a runtime is provided", () => {
    const runtime = {
      listLoadedResources: vi.fn<() => X402LoadedResource[]>().mockReturnValue([
        {
          id: "r",
          kind: "http",
          method: "GET",
          publicPath: "/api/z",
          paymentPath: "/api/z",
          upstreamUrl: "https://upstream.test/z",
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
        },
      ]),
    };
    const handler = createDiscoveryHandler(discovery, [], runtime);
    const res = new FakeResponse();
    handler({} as never, res as never, vi.fn());
    expect(runtime.listLoadedResources).toHaveBeenCalled();
    expect((res.body as { resources: string[] }).resources).toEqual([
      "https://api.example.com/api/z",
    ]);
  });

  it("falls back to configured endpoints without a runtime", () => {
    const handler = createDiscoveryHandler(discovery, [httpEndpoint]);
    const res = new FakeResponse();
    handler({} as never, res as never, vi.fn());
    expect((res.body as { resources: string[] }).resources).toEqual([
      "https://api.example.com/api/x",
    ]);
  });
});

describe("installDiscoveryEndpoints", () => {
  function fakeApp(): { get: ReturnType<typeof vi.fn>; routes: string[] } {
    const routes: string[] = [];
    return {
      routes,
      get: vi.fn((path: string) => {
        routes.push(path);
      }),
    };
  }

  it("registers both discovery routes when enabled", () => {
    const app = fakeApp();
    installDiscoveryEndpoints(app as never, discovery, [httpEndpoint]);
    expect(app.routes).toEqual(["/.well-known/x402", "/x402-discovery.json"]);
  });

  it("registers nothing when discovery is undefined or disabled", () => {
    const undefinedApp = fakeApp();
    installDiscoveryEndpoints(undefinedApp as never, undefined, []);
    expect(undefinedApp.get).not.toHaveBeenCalled();

    const disabledApp = fakeApp();
    installDiscoveryEndpoints(disabledApp as never, { enabled: false, publicBaseUrl: "x" }, []);
    expect(disabledApp.get).not.toHaveBeenCalled();
  });
});
