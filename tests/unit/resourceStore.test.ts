import { describe, expect, it } from "vitest";

import { RouteBuildError, ValidationError } from "../../src/errors";
import { createResourceServer } from "../../src/x402Server";
import { X402ResourceRuntime } from "../../src/resourceRuntime";
import {
  createAccessEvent,
  InMemoryX402AccessEventStore,
  InMemoryX402ResourceStore,
  NoopX402AccessEventStore,
  validateX402Resource,
} from "../../src/resourceStore";
import type { X402AccessEvent, X402Resource } from "../../src/types";

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

  it("rejects upstream placeholders that do not occupy a full path segment", () => {
    const partialSegment = validateX402Resource(
      createResource({
        upstreamUrl: "https://upstream.example.com/v1/user-[username]/[slug]/chat",
      }),
    );
    expect(partialSegment.map((issue) => issue.reason)).toContain(
      "upstreamUrl placeholder [username] must occupy a full path segment",
    );

    const queryPlaceholder = validateX402Resource(
      createResource({
        upstreamUrl: "https://upstream.example.com/v1/[username]/[slug]/chat?user=[username]",
      }),
    );
    expect(queryPlaceholder.map((issue) => issue.reason)).toContain(
      "upstreamUrl placeholder [username] must occupy a full path segment",
    );
  });

  it("rejects placeholders in websocket upstream URLs, which are connected verbatim", () => {
    const issues = validateX402Resource(
      createResource({
        kind: "websocket",
        method: "GET",
        publicPath: "/ws/[room]/feed",
        upstreamUrl: "wss://upstream.example.com/feed/[room]",
        stream: {
          leasePath: "/ws/lease",
          leaseSeconds: 60,
          allowRenewal: false,
          renewalWindowSeconds: 0,
        },
      }),
    );

    expect(issues.map((issue) => issue.reason)).toContain(
      "websocket upstreamUrl must not contain placeholder [room]",
    );
  });

  it("rejects invalid service-token header names and control characters in values", () => {
    const badName = validateX402Resource(
      createResource({
        access: { mode: "service-token", serviceTokenHeader: "X Auth ", serviceTokenValue: "ok" },
      }),
    );
    expect(badName.map((issue) => issue.reason)).toContain(
      "access.serviceTokenHeader must be a valid HTTP header name (RFC 9110 token, no whitespace)",
    );

    const badValue = validateX402Resource(
      createResource({
        access: {
          mode: "service-token",
          serviceTokenHeader: "Authorization",
          serviceTokenValue: "Bearer abc\r\nX-Injected: 1",
        },
      }),
    );
    expect(badValue.map((issue) => issue.reason)).toContain(
      "access.serviceTokenValue must not contain control characters",
    );
    expect(JSON.stringify(badValue)).not.toContain("Bearer abc");
  });

  it("validates service-token access configuration without leaking the token value", () => {
    const missingConfig = validateX402Resource(createResource({ access: { mode: "service-token" } }));
    expect(missingConfig.map((issue) => issue.reason)).toEqual(
      expect.arrayContaining([
        "access.serviceTokenHeader is required for service-token mode",
        "access.serviceTokenValue is required for service-token mode",
      ]),
    );

    const protectedHeader = validateX402Resource(
      createResource({
        access: { mode: "service-token", serviceTokenHeader: "X-Payment", serviceTokenValue: "topsecret" },
      }),
    );
    expect(protectedHeader.map((issue) => issue.reason)).toContain(
      "access.serviceTokenHeader must not be a payment, hop-by-hop, host, or content-length header",
    );
    expect(JSON.stringify(protectedHeader)).not.toContain("topsecret");

    const valid = validateX402Resource(
      createResource({
        access: { mode: "service-token", serviceTokenHeader: "Authorization", serviceTokenValue: "Bearer svc" },
      }),
    );
    expect(valid).toEqual([]);

    const passThrough = validateX402Resource(createResource({ access: { mode: "pass-through" } }));
    expect(passThrough).toEqual([]);
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

  it("reports a specific reason for each invalid resource field", () => {
    const reasons = (resource: X402Resource): string[] =>
      validateX402Resource(resource).map((issue) => issue.reason);

    expect(reasons(createResource({ id: "" }))).toContain("id must be a non-empty string");
    expect(reasons(createResource({ kind: "bogus" as X402Resource["kind"] }))).toContain(
      "kind must be http, http-stream, or websocket",
    );
    expect(reasons(createResource({ method: "TRACE" as X402Resource["method"] }))).toContain(
      "method is not supported",
    );
    expect(reasons(createResource({ publicPath: "no-slash" }))).toContain("publicPath must start with /");
    expect(
      reasons(createResource({ kind: "websocket", upstreamUrl: "https://x", stream: { leasePath: "/l", leaseSeconds: 60, allowRenewal: false, renewalWindowSeconds: 0 } })),
    ).toContain("websocket upstreamUrl must use ws: or wss:");
    expect(reasons(createResource({ upstreamUrl: "ftp://x" }))).toContain("upstreamUrl must use http: or https:");
    expect(reasons(createResource({ pricing: { amount: "0", network: "eip155:8453", payTo: "0xPayee" } }))).toContain(
      "pricing.amount must be a positive decimal string",
    );
    expect(reasons(createResource({ pricing: { amount: "0.01", network: "bad" as X402Resource["pricing"]["network"], payTo: "0xPayee" } }))).toContain(
      "pricing.network must be CAIP-2 and use eip155:* or solana:*",
    );
    expect(reasons(createResource({ pricing: { amount: "0.01", network: "eip155:8453", payTo: "" } }))).toContain(
      "pricing.payTo must be a non-empty string",
    );
    expect(reasons(createResource({ kind: "http-stream" }))).toContain(
      "stream config is required for http-stream and websocket resources",
    );
    expect(
      reasons(
        createResource({
          kind: "http-stream",
          stream: { leasePath: "nope", leaseSeconds: 0, allowRenewal: false, renewalWindowSeconds: -1 },
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        "stream.leasePath must start with /",
        "stream.leaseSeconds must be > 0",
        "stream.renewalWindowSeconds must be >= 0",
      ]),
    );
  });

  it("throws when constructing a store with invalid resources", () => {
    expect(() => new InMemoryX402ResourceStore([createResource({ id: "" })])).toThrow(ValidationError);
  });

  it("throws on duplicate enabled resource routes", () => {
    expect(
      () =>
        new InMemoryX402ResourceStore([
          createResource({ id: "a" }),
          createResource({ id: "b" }),
        ]),
    ).toThrow(RouteBuildError);
  });

  it("looks up resources by id and lists only enabled ones", async () => {
    const store = new InMemoryX402ResourceStore([
      createResource({ id: "enabled" }),
      createResource({ id: "disabled", enabled: false, publicPath: "/paid/other/[username]/[slug]/chat" }),
    ]);
    expect((await store.getResourceById("enabled"))?.id).toBe("enabled");
    expect(await store.getResourceById("missing")).toBeNull();
    expect((await store.listEnabledResources()).map((resource) => resource.id)).toEqual(["enabled"]);
  });

  it("provides noop and in-memory access event stores", async () => {
    await expect(new NoopX402AccessEventStore().record({} as X402AccessEvent)).resolves.toBeUndefined();
    const store = new InMemoryX402AccessEventStore();
    const event = createAccessEvent({
      resourceId: "r",
      kind: "verified",
      requestMethod: "GET",
      requestPath: "/p",
    });
    await store.record(event);
    expect(store.events).toContain(event);
    expect(event.id).toBeTruthy();
    expect(event.createdAt).toBeGreaterThan(0);
  });
});
