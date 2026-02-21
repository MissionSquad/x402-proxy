import { paymentMiddleware } from "@x402/express";
import type { RoutesConfig, x402ResourceServer } from "@x402/core/server";
import type { RequestHandler } from "express";

/**
 * Create x402 Express payment middleware for the route set.
 */
export function createPaymentMiddleware(
  routes: RoutesConfig,
  server: x402ResourceServer,
  syncFacilitatorOnStart: boolean,
): RequestHandler {
  return paymentMiddleware(routes, server, undefined, undefined, syncFacilitatorOnStart);
}
