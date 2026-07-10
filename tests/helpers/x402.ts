import { createServer, type Server } from "node:http";

import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import express, { type Express } from "express";
import { expect } from "vitest";

export type RunningServer = {
  server: Server;
  url: string;
  close: () => Promise<void>;
};

export async function startExpressServer(app: Express): Promise<RunningServer> {
  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve listen address");
  }
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

export type FacilitatorControls = { settleSucceeds: boolean; networks: string[] };

export function createFacilitatorApp(controls: FacilitatorControls): Express {
  const app = express();
  app.use(express.json());
  app.get("/supported", (_req, res) => {
    res.json({
      kinds: controls.networks.map((network) => ({ x402Version: 2, scheme: "exact", network })),
      extensions: [],
      signers: {},
    });
  });
  app.post("/verify", (_req, res) => {
    res.json({ isValid: true, payer: "payer" });
  });
  app.post("/settle", (req, res) => {
    const network =
      (req.body as { paymentRequirements?: { network?: string } }).paymentRequirements?.network ??
      controls.networks[0];
    if (!controls.settleSucceeds) {
      res.json({ success: false, errorReason: "insufficient_funds" });
      return;
    }
    res.json({ success: true, transaction: "0xsettled", network });
  });
  return app;
}

export async function readPaymentRequirement(
  url: string,
  method: "GET" | "POST" = "GET",
  init?: Pick<RequestInit, "body" | "headers">,
): Promise<{ paymentRequired: PaymentRequired; accepted: PaymentRequirements }> {
  const response = await fetch(url, { method, ...init });
  expect(response.status).toBe(402);
  const encoded = response.headers.get("payment-required");
  if (!encoded) {
    throw new Error("Missing PAYMENT-REQUIRED header");
  }
  const paymentRequired = decodePaymentRequiredHeader(encoded);
  const accepted = paymentRequired.accepts[0];
  if (!accepted) {
    throw new Error("Expected at least one payment requirement");
  }
  return { paymentRequired, accepted };
}

export function buildPaymentHeader(
  paymentRequired: PaymentRequired,
  accepted: PaymentRequirements,
): string {
  const payload: PaymentPayload = {
    x402Version: paymentRequired.x402Version,
    resource: paymentRequired.resource,
    accepted,
    payload: { test: true },
  };
  return encodePaymentSignatureHeader(payload);
}
