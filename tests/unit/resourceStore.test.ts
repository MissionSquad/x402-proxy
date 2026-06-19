import { describe, expect, it } from "vitest";

import { createResourceServer } from "../../src/x402Server";
import { X402ResourceRuntime } from "../../src/resourceRuntime";
import { InMemoryX402ResourceStore, validateX402Resource } from "../../src/resourceStore";
import type { X402Resource } from "../../src/types";

function createResource(overrides: Partial<X402Resource> = {}): X402Resource {
  return {
    id: "dynamic-chat",
    enabled: true,
    kind: "http",
    method: "POST",
    publicPath: "/paid/agents/[username]/[slug]/chat",
    upstreamUrl: "https://upstream.example.com/v1/[username]/[slug]/chat",
    pricing: {
      amount: "0.01",
      network: "eip155:8453",
      payTo: "0xPayee",
    },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("resourceStore", () => {
  it("validates upstream placeholders against publicPath params", () => {
    const issues = validateX402Resource(
      createResource({
        upstreamUrl: "https://upstream.example.com/v1/[missing]/chat",
      }),
    );

    expect(issues.map((issue) => issue.reason)).toContain(
      "upstreamUrl placeholder [missing] is not present in publicPath",
    );
  });

  it("matches in-memory resources by dynamic path", async () => {
    const store = new InMemoryX402ResourceStore([createResource()]);
    const resource = await store.getResourceForRequest("POST", "/paid/agents/jayson/research/chat");

    expect(resource?.id).toBe("dynamic-chat");
  });

  it("refresh skips invalid resources and reports diagnostics when not required", async () => {
    const valid = createResource();
    const invalid = createResource({
      id: "invalid",
      upstreamUrl: "https://upstream.example.com/[missing]",
    });
    const store = {
      listEnabledResources: async () => [valid, invalid],
      getResourceById: async () => null,
      getResourceForRequest: async () => null,
    };

    const runtime = new X402ResourceRuntime({
      store,
      resourceServer: createResourceServer(),
      leaseTokenSecret: "lease-token-secret-with-32-characters",
      syncFacilitatorOnStart: false,
      requireProtectedResources: false,
    });

    const result = await runtime.refreshResources();
    expect(result.loaded.map((resource) => resource.id)).toEqual(["dynamic-chat"]);
    expect(result.invalid).toHaveLength(1);
    expect(runtime.diagnostics().invalidResourceCount).toBe(1);
  });
});
