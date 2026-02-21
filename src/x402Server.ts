import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import { registerExactSvmScheme } from "@x402/svm/exact/server";

/**
 * Create and configure x402 resource server with EVM and SVM exact scheme support.
 */
export function createResourceServer(facilitatorUrl?: string, bearer?: string): x402ResourceServer {
  const facilitatorConfig: {
    url?: string;
    createAuthHeaders?: () => Promise<{
      verify: Record<string, string>;
      settle: Record<string, string>;
      supported: Record<string, string>;
    }>;
  } = {};

  if (facilitatorUrl) {
    facilitatorConfig.url = facilitatorUrl;
  }
  if (bearer) {
    facilitatorConfig.createAuthHeaders = async () => ({
      verify: { Authorization: `Bearer ${bearer}` },
      settle: { Authorization: `Bearer ${bearer}` },
      supported: { Authorization: `Bearer ${bearer}` },
    });
  }

  const client = new HTTPFacilitatorClient(facilitatorConfig);

  const server = new x402ResourceServer(client);
  registerExactEvmScheme(server);
  registerExactSvmScheme(server);
  return server;
}
