import { describe, expect, it } from "vitest";

import {
  LeaseTokenError,
  RequestBodyTooLargeError,
  RouteBuildError,
  SecurityPolicyError,
  UpstreamRequestError,
  UpstreamTimeoutError,
} from "../../src/errors";
import { sendProxyErrorResponse } from "../../src/resourceRuntime";
import { FakeResponse } from "../helpers/fakeHttp";

describe("sendProxyErrorResponse", () => {
  it("maps each error type to a clean status + code", () => {
    const cases: Array<[unknown, number, string]> = [
      [new SecurityPolicyError("blocked"), 403, "SECURITY_POLICY_ERROR"],
      [new RequestBodyTooLargeError("too big"), 413, "REQUEST_BODY_TOO_LARGE_ERROR"],
      [new UpstreamRequestError("bad gateway"), 502, "UPSTREAM_REQUEST_ERROR"],
      [new UpstreamTimeoutError("timed out"), 502, "UPSTREAM_TIMEOUT_ERROR"],
      [new LeaseTokenError("bad lease"), 401, "LEASE_TOKEN_ERROR"],
      [new RouteBuildError("config fault"), 500, "ROUTE_BUILD_ERROR"],
    ];
    for (const [error, status, code] of cases) {
      const res = new FakeResponse();
      sendProxyErrorResponse(res as never, error);
      expect(res.statusCode).toBe(status);
      expect((res.body as { code: string }).code).toBe(code);
    }
  });

  it("maps an AbortError to 504", () => {
    const res = new FakeResponse();
    const error = new Error("aborted");
    error.name = "AbortError";
    sendProxyErrorResponse(res as never, error);
    expect(res.statusCode).toBe(504);
    expect((res.body as { code: string }).code).toBe("UPSTREAM_TIMEOUT_ERROR");
  });

  it("maps a DOMException-shaped abort (not instanceof Error) to 504", () => {
    const res = new FakeResponse();
    sendProxyErrorResponse(res as never, { name: "AbortError", message: "This operation was aborted" });
    expect(res.statusCode).toBe(504);
    expect((res.body as { code: string }).code).toBe("UPSTREAM_TIMEOUT_ERROR");
  });

  it("maps an unknown error to a generic 500 with no detail", () => {
    const res = new FakeResponse();
    sendProxyErrorResponse(res as never, new Error("kaboom"));
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "Internal proxy error", code: "INTERNAL_ERROR" });
  });

  it("does nothing once the response has already started", () => {
    const res = new FakeResponse();
    res.headersSent = true;
    sendProxyErrorResponse(res as never, new SecurityPolicyError("blocked"));
    expect(res.body).toBeUndefined();
    expect(res.statusCode).toBe(200);
  });
});
