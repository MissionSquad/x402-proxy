import { describe, expect, it } from "vitest";

import {
  applyServiceTokenAccess,
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

  it("limits presets to the spec-exact lists; extras require explicit forwardRequestHeaders", () => {
    const req = { headers: { "x-webhook-secret": "shhh", "x-request-id": "abc", accept: "*/*" } };
    const presetOnly = createForwardHeaders(req as unknown as Parameters<typeof createForwardHeaders>[0], {
      presets: ["api-auth"],
    });
    expect(presetOnly.get("x-webhook-secret")).toBeNull();
    expect(presetOnly.get("x-request-id")).toBeNull();
    expect(presetOnly.get("accept")).toBe("*/*");

    const extended = createForwardHeaders(req as unknown as Parameters<typeof createForwardHeaders>[0], {
      presets: ["api-auth"],
      forwardRequestHeaders: ["x-webhook-secret", "x-request-id"],
    });
    expect(extended.get("x-webhook-secret")).toBe("shhh");
    expect(extended.get("x-request-id")).toBe("abc");
  });

  it("excludes preset-granted request headers via excludeRequestHeaders", () => {
    const req = {
      headers: { cookie: "session=1", authorization: "Bearer secret", accept: "*/*" },
    };
    const headers = createForwardHeaders(req as unknown as Parameters<typeof createForwardHeaders>[0], {
      presets: ["browser-auth"],
      excludeRequestHeaders: ["Cookie"],
    });
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("authorization")).toBe("Bearer secret");
    expect(headers.get("accept")).toBe("*/*");
  });

  it("joins array-valued request headers", () => {
    const req = { headers: { "x-api-key": ["a", "b"] } };
    const headers = createForwardHeaders(req as unknown as Parameters<typeof createForwardHeaders>[0], {
      presets: ["api-auth"],
    });
    expect(headers.get("x-api-key")).toBe("a, b");
  });
});

describe("applyServiceTokenAccess", () => {
  it("injects the service token, replacing any client-forwarded value", () => {
    const headers = new Headers({ authorization: "Bearer user-token" });
    applyServiceTokenAccess(headers, {
      mode: "service-token",
      serviceTokenHeader: "Authorization",
      serviceTokenValue: "Bearer service-token",
    });
    expect(headers.get("authorization")).toBe("Bearer service-token");
  });

  it("does nothing for pass-through, missing config, or protected header names", () => {
    const headers = new Headers({ authorization: "Bearer user-token" });
    applyServiceTokenAccess(headers, { mode: "pass-through" });
    applyServiceTokenAccess(headers, { mode: "service-token" });
    applyServiceTokenAccess(headers, {
      mode: "service-token",
      serviceTokenHeader: "x-payment",
      serviceTokenValue: "leak",
    });
    applyServiceTokenAccess(headers, undefined);
    expect(headers.get("authorization")).toBe("Bearer user-token");
    expect(headers.get("x-payment")).toBeNull();
  });

  it("skips invalid header names and values without throwing (bypassed-validation defense)", () => {
    const headers = new Headers({ authorization: "Bearer user-token" });
    expect(() =>
      applyServiceTokenAccess(headers, {
        mode: "service-token",
        serviceTokenHeader: "X Auth ",
        serviceTokenValue: "ok",
      }),
    ).not.toThrow();
    expect(() =>
      applyServiceTokenAccess(headers, {
        mode: "service-token",
        serviceTokenHeader: "x-service-auth",
        serviceTokenValue: "abc\r\nx-injected: 1",
      }),
    ).not.toThrow();
    // Non-CR/LF control characters (SOH, DEL) are rejected too, not just injection bytes.
    applyServiceTokenAccess(headers, {
      mode: "service-token",
      serviceTokenHeader: "x-service-auth",
      serviceTokenValue: `abc${String.fromCharCode(1)}`,
    });
    applyServiceTokenAccess(headers, {
      mode: "service-token",
      serviceTokenHeader: "x-service-auth",
      serviceTokenValue: `abc${String.fromCharCode(127)}`,
    });
    expect(headers.get("authorization")).toBe("Bearer user-token");
    expect(headers.get("x-service-auth")).toBeNull();
    expect(headers.get("x-injected")).toBeNull();
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

  it("excludes default-forwarded response headers via excludeResponseHeaders", () => {
    const res = new FakeResponse();
    applyUpstreamResponseHeaders(
      res as never,
      upstream({ "content-type": "application/json", etag: 'W/"1"' }),
      { excludeResponseHeaders: ["ETag"] },
    );
    expect(res.headers["content-type"]).toBe("application/json");
    expect(res.headers["etag"]).toBeUndefined();
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
