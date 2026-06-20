export type X402ProxyErrorCode =
  | "CONFIGURATION_ERROR"
  | "VALIDATION_ERROR"
  | "PRICE_CONVERSION_ERROR"
  | "ROUTE_BUILD_ERROR"
  | "UPSTREAM_REQUEST_ERROR"
  | "UPSTREAM_TIMEOUT_ERROR"
  | "SECURITY_POLICY_ERROR"
  | "LEASE_TOKEN_ERROR"
  | "REQUEST_BODY_TOO_LARGE_ERROR";

export abstract class X402ProxyError extends Error {
  public readonly code: X402ProxyErrorCode;

  public readonly context: Record<string, unknown> | undefined;

  protected constructor(
    name: string,
    code: X402ProxyErrorCode,
    message: string,
    context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = name;
    this.code = code;
    this.context = context;
  }
}

export class ConfigurationError extends X402ProxyError {
  constructor(message: string, context?: Record<string, unknown>) {
    super("ConfigurationError", "CONFIGURATION_ERROR", message, context);
  }
}

export class ValidationError extends X402ProxyError {
  constructor(message: string, context?: Record<string, unknown>) {
    super("ValidationError", "VALIDATION_ERROR", message, context);
  }
}

export class PriceConversionError extends X402ProxyError {
  constructor(message: string, context?: Record<string, unknown>) {
    super("PriceConversionError", "PRICE_CONVERSION_ERROR", message, context);
  }
}

export class RouteBuildError extends X402ProxyError {
  constructor(message: string, context?: Record<string, unknown>) {
    super("RouteBuildError", "ROUTE_BUILD_ERROR", message, context);
  }
}

export class UpstreamRequestError extends X402ProxyError {
  constructor(message: string, context?: Record<string, unknown>) {
    super("UpstreamRequestError", "UPSTREAM_REQUEST_ERROR", message, context);
  }
}

export class UpstreamTimeoutError extends X402ProxyError {
  constructor(message: string, context?: Record<string, unknown>) {
    super("UpstreamTimeoutError", "UPSTREAM_TIMEOUT_ERROR", message, context);
  }
}

export class SecurityPolicyError extends X402ProxyError {
  constructor(message: string, context?: Record<string, unknown>) {
    super("SecurityPolicyError", "SECURITY_POLICY_ERROR", message, context);
  }
}

export class LeaseTokenError extends X402ProxyError {
  constructor(message: string, context?: Record<string, unknown>) {
    super("LeaseTokenError", "LEASE_TOKEN_ERROR", message, context);
  }
}

export class RequestBodyTooLargeError extends X402ProxyError {
  constructor(message: string, context?: Record<string, unknown>) {
    super("RequestBodyTooLargeError", "REQUEST_BODY_TOO_LARGE_ERROR", message, context);
  }
}
