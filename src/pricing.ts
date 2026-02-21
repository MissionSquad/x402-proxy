import BigNumber from "bignumber.js";

import { PriceConversionError } from "./errors";

/**
 * Convert a positive decimal amount string to base units with deterministic ceiling rounding.
 *
 * @throws PriceConversionError When amount or decimals are invalid.
 */
export function toBaseUnits(decimalAmount: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new PriceConversionError("decimals must be a non-negative integer", { decimals });
  }

  const amount = new BigNumber(decimalAmount);
  if (!amount.isFinite() || amount.lte(0)) {
    throw new PriceConversionError(`Invalid amount: ${decimalAmount}`, { decimalAmount });
  }

  const scaled = amount.times(new BigNumber(10).pow(decimals));
  return scaled.integerValue(BigNumber.ROUND_CEIL).toFixed(0);
}
