import type { Network, Price } from "@x402/core/types";
import { getUsdcAddress } from "@x402/svm";

import { PriceConversionError } from "./errors";
import type { CurrencyInput } from "./types";
import { toBaseUnits } from "./pricing";

/**
 * Resolve endpoint decimal pricing into x402 Price, including optional asset overrides.
 *
 * @throws PriceConversionError When an EVM currency override omits asset.
 */
export function resolvePrice(
  network: Network,
  decimalPrice: string,
  currency?: CurrencyInput,
): Price {
  if (!currency) {
    return decimalPrice;
  }

  const decimals = currency.decimals ?? 6;
  const amount = toBaseUnits(decimalPrice, decimals);

  if (currency.asset) {
    return { asset: currency.asset, amount };
  }

  if (network.startsWith("solana:")) {
    return { asset: getUsdcAddress(network), amount };
  }

  throw new PriceConversionError(
    "currency.asset is required for eip155 networks when currency override is provided",
    { network, currency },
  );
}
