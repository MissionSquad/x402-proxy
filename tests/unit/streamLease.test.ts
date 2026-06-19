import { describe, expect, it } from "vitest";

import { LeaseTokenError } from "../../src/errors";
import {
  InMemoryX402LeaseUseStore,
  createHttpStreamLeaseToken,
  issueHttpStreamLease,
  verifyHttpStreamLeaseToken,
} from "../../src/streamLease";
import type { X402Resource } from "../../src/types";

function createStreamResource(): X402Resource {
  return {
    id: "chat-stream",
    enabled: true,
    kind: "http-stream",
    method: "POST",
    publicPath: "/paid/agents/[username]/[slug]/chat",
    upstreamUrl: "https://upstream.example.com/v1/[username]/[slug]/chat",
    pricing: {
      amount: "0.01",
      network: "eip155:8453",
      payTo: "0xPayee",
    },
    stream: {
      leasePath: "/paid/agents/[username]/[slug]/chat/lease",
      leaseSeconds: 60,
      allowRenewal: false,
      renewalWindowSeconds: 10,
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("streamLease", () => {
  it("issues and verifies HTTP stream leases bound to the resource", () => {
    const secret = "lease-token-secret-with-32-characters";
    const resource = createStreamResource();
    const lease = issueHttpStreamLease(
      resource,
      secret,
      new URL("https://proxy.example.com"),
      { username: "jayson", slug: "research" },
    );

    expect(lease.streamUrl.startsWith("https://proxy.example.com/paid/agents/jayson/research/chat?t=")).toBe(
      true,
    );
    const decoded = verifyHttpStreamLeaseToken(lease.token, secret, {
      resourceId: resource.id,
      method: resource.method,
      publicPath: resource.publicPath,
      upstreamUrl: resource.upstreamUrl,
    });
    expect(decoded.resourceId).toBe("chat-stream");
  });

  it("rejects token/resource mismatches and token reuse", async () => {
    const secret = "lease-token-secret-with-32-characters";
    const token = createHttpStreamLeaseToken(
      {
        resourceId: "chat-stream",
        exp: Math.floor(Date.now() / 1000) + 60,
        jti: "jti-1",
        method: "POST",
        publicPath: "/paid/chat",
        upstreamUrl: "https://upstream.example.com/chat",
      },
      secret,
    );

    expect(() =>
      verifyHttpStreamLeaseToken(token, secret, {
        resourceId: "other",
        method: "POST",
        publicPath: "/paid/chat",
        upstreamUrl: "https://upstream.example.com/chat",
      }),
    ).toThrow(LeaseTokenError);

    const decoded = verifyHttpStreamLeaseToken(token, secret, {
      resourceId: "chat-stream",
      method: "POST",
      publicPath: "/paid/chat",
      upstreamUrl: "https://upstream.example.com/chat",
    });
    const store = new InMemoryX402LeaseUseStore();
    expect(await store.consume(decoded.jti, decoded.exp)).toBe(true);
    expect(await store.consume(decoded.jti, decoded.exp)).toBe(false);
  });
});
