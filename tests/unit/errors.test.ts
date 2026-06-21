import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  LeaseTokenError,
  PriceConversionError,
  RequestBodyTooLargeError,
  RouteBuildError,
  SecurityPolicyError,
  UpstreamRequestError,
  UpstreamTimeoutError,
  ValidationError,
  X402ProxyError,
} from "../../src/errors";

const cases: Array<[new (m: string, c?: Record<string, unknown>) => X402ProxyError, string, string]> = [
  [ConfigurationError, "ConfigurationError", "CONFIGURATION_ERROR"],
  [ValidationError, "ValidationError", "VALIDATION_ERROR"],
  [PriceConversionError, "PriceConversionError", "PRICE_CONVERSION_ERROR"],
  [RouteBuildError, "RouteBuildError", "ROUTE_BUILD_ERROR"],
  [UpstreamRequestError, "UpstreamRequestError", "UPSTREAM_REQUEST_ERROR"],
  [UpstreamTimeoutError, "UpstreamTimeoutError", "UPSTREAM_TIMEOUT_ERROR"],
  [SecurityPolicyError, "SecurityPolicyError", "SECURITY_POLICY_ERROR"],
  [LeaseTokenError, "LeaseTokenError", "LEASE_TOKEN_ERROR"],
  [RequestBodyTooLargeError, "RequestBodyTooLargeError", "REQUEST_BODY_TOO_LARGE_ERROR"],
];

describe("error classes", () => {
  it.each(cases)("%s carries name, code, message and context", (Ctor, name, code) => {
    const withContext = new Ctor("boom", { detail: 1 });
    expect(withContext).toBeInstanceOf(X402ProxyError);
    expect(withContext).toBeInstanceOf(Error);
    expect(withContext.name).toBe(name);
    expect(withContext.code).toBe(code);
    expect(withContext.message).toBe("boom");
    expect(withContext.context).toEqual({ detail: 1 });

    const withoutContext = new Ctor("plain");
    expect(withoutContext.context).toBeUndefined();
  });
});
