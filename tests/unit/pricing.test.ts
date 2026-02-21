import { describe, expect, it } from "vitest";

import { resolvePrice } from "../../src/currency";
import { PriceConversionError } from "../../src/errors";
import { toBaseUnits } from "../../src/pricing";

describe("toBaseUnits", () => {
  it("rounds up deterministically", () => {
    expect(toBaseUnits("0.0000011", 6)).toBe("2");
    expect(toBaseUnits("1.25", 2)).toBe("125");
  });

  it("throws on invalid input", () => {
    expect(() => toBaseUnits("0", 6)).toThrow(PriceConversionError);
    expect(() => toBaseUnits("-1", 6)).toThrow(PriceConversionError);
    expect(() => toBaseUnits("1", -1)).toThrow(PriceConversionError);
  });
});

describe("resolvePrice", () => {
  it("returns plain money when currency omitted", () => {
    expect(resolvePrice("eip155:8453", "0.01")).toBe("0.01");
  });

  it("resolves explicit asset", () => {
    expect(
      resolvePrice("eip155:8453", "0.01", {
        asset: "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        decimals: 6,
      }),
    ).toEqual({
      asset: "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      amount: "10000",
    });
  });

  it("infers SVM USDC asset when override omits asset", () => {
    expect(
      resolvePrice("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "0.25", { decimals: 6 }),
    ).toEqual({
      asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      amount: "250000",
    });
  });

  it("rejects EVM override without explicit asset", () => {
    expect(() => resolvePrice("eip155:1", "0.10", { decimals: 6 })).toThrow(PriceConversionError);
  });
});
