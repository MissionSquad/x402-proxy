import { describe, expect, it } from "vitest";

import {
  applyUpstreamResponseHeaders,
  createForwardHeaders,
  shouldDropProxyHeader,
} from "../../src/headerPolicy";
import { FakeResponse } from "../helpers/fakeHttp";

describe("headerPolicy", () => {
  it("applies auth presets while suppressing payment and hop-by-hop headers", () => {
    const req = {
      headers: {
        authorization: "Bearer secret",
        "x-api-key": "api-secret",
        "payment-signature": "payment",
        connection: "keep-alive",
        host: "proxy.example.com",
        accept: "application/json",
      },
    };

    const headers = createForwardHeaders(req as unknown as Parameters<typeof createForwardHeaders>[0], {
      presets: ["api-auth"],
    });

    expect(headers.get("authorization")).toBe("Bearer secret");
    expect(headers.get("x-api-key")).toBe("api-secret");
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("payment-signature")).toBeNull();
    expect(headers.get("connection")).toBeNull();
    expect(headers.get("host")).toBeNull();
  });

  it("never allows protected headers through explicit additions", () => {
    const req = { headers: {} };
    const headers = createForwardHeaders(req as unknown as Parameters<typeof createForwardHeaders>[0], {
      addRequestHeaders: {
        "X-X402-Lease": "lease-secret",
        "Content-Length": "100",
        "X-Safe": "ok",
      },
    });

    expect(headers.get("x-x402-lease")).toBeNull();
    expect(headers.get("content-length")).toBeNull();
    expect(headers.get("x-safe")).toBe("ok");
    expect(shouldDropProxyHeader("x-payment")).toBe(true);
  });

  it("forwards the x-webhook-secret auth header under the api-auth preset", () => {
    const req = { headers: { "x-webhook-secret": "shhh", "x-request-id": "abc" } };
    const headers = createForwardHeaders(req as unknown as Parameters<typeof createForwardHeaders>[0], {
      presets: ["api-auth"],
    });
    expect(headers.get("x-webhook-secret")).toBe("shhh");
    expect(headers.get("x-request-id")).toBe("abc");
  });

  it("joins array-valued request headers", () => {
    const req = { headers: { "x-api-key": ["a", "b"] } };
    const headers = createForwardHeaders(req as unknown as Parameters<typeof createForwardHeaders>[0], {
      presets: ["api-auth"],
    });
    expect(headers.get("x-api-key")).toBe("a, b");
  });
});

describe("applyUpstreamResponseHeaders", () => {
  function upstream(headers: Record<string, string>): globalThis.Response {
    return new Response("body", { headers });
  }

  it("forwards a safe default header set even with no preset", () => {
    const res = new FakeResponse();
    applyUpstreamResponseHeaders(
      res as never,
      upstream({ "content-type": "application/json", etag: 'W/"1"', "x-custom": "drop-me" }),
    );
    expect(res.headers["content-type"]).toBe("application/json");
    expect(res.headers["etag"]).toBe('W/"1"');
    expect(res.headers["x-custom"]).toBeUndefined();
  });

  it("never forwards managed (content-encoding/content-length) or hop-by-hop headers", () => {
    const res = new FakeResponse();
    applyUpstreamResponseHeaders(
      res as never,
      upstream({
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": "10",
        connection: "keep-alive",
      }),
      { forwardResponseHeaders: ["content-encoding", "content-length", "connection"] },
    );
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.headers["content-length"]).toBeUndefined();
    expect(res.headers["connection"]).toBeUndefined();
    expect(res.headers["content-type"]).toBe("application/json");
  });

  it("honors forwardResponseHeaders and addResponseHeaders, dropping protected additions", () => {
    const res = new FakeResponse();
    applyUpstreamResponseHeaders(res as never, upstream({ "x-run-id": "run-1" }), {
      forwardResponseHeaders: ["x-run-id"],
      addResponseHeaders: { "x-extra": "v", "x-payment": "leak" },
    });
    expect(res.headers["x-run-id"]).toBe("run-1");
    expect(res.headers["x-extra"]).toBe("v");
    expect(res.headers["x-payment"]).toBeUndefined();
  });
});
