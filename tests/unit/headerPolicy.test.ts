import { describe, expect, it } from "vitest";

import { createForwardHeaders, shouldDropProxyHeader } from "../../src/headerPolicy";

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
});
