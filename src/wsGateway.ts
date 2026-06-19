import { LeaseTokenError } from "./errors";
import { createAccessEvent } from "./resourceStore";
import type { X402AccessEventStore, X402Resource } from "./types";
import { verifyLeaseToken } from "./wsLease";

/**
 * Minimal bidirectional websocket connection abstraction.
 */
export interface WebSocketConnection {
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  onMessage(handler: (data: string | Buffer) => void): void;
  onClose(handler: () => void): void;
  onError(handler: (error: Error) => void): void;
}

/**
 * Minimal websocket server abstraction for path-based connection handling.
 */
export interface WebSocketServerAdapter {
  onConnection(path: string, handler: (query: URLSearchParams, conn: WebSocketConnection) => void): void;
}

/**
 * Adapter used to create an upstream websocket connection.
 */
export interface UpstreamWebSocketConnector {
  connect(url: string): Promise<WebSocketConnection>;
}

export type WebSocketGatewayEndpoint = {
  id: string;
  wsPath: string;
  upstreamWsUrl: string;
};

export type WebSocketGatewayConfig = {
  leaseTokenSecret: string;
  endpoints: WebSocketGatewayEndpoint[];
  allowTokenReuse?: boolean;
  accessEventStore?: X402AccessEventStore;
};

const CLOSE_POLICY_VIOLATION = 1008;
const CLOSE_INTERNAL_ERROR = 1011;

/**
 * Install token-validated WS relay endpoints onto a server adapter.
 */
export function installWebSocketGateway(
  adapter: WebSocketServerAdapter,
  connector: UpstreamWebSocketConnector,
  config: WebSocketGatewayConfig,
): void {
  const endpointByPath = new Map<string, WebSocketGatewayEndpoint>();
  for (const endpoint of config.endpoints) {
    endpointByPath.set(endpoint.wsPath, endpoint);
  }

  const consumedTokens = new Map<string, number>();

  const cleanupConsumed = (nowUnixSeconds: number): void => {
    for (const [jti, exp] of consumedTokens.entries()) {
      if (exp <= nowUnixSeconds) {
        consumedTokens.delete(jti);
      }
    }
  };

  for (const [path, endpoint] of endpointByPath.entries()) {
    adapter.onConnection(path, async (query, clientConn) => {
      const token = query.get("t");
      if (!token) {
        clientConn.close(CLOSE_POLICY_VIOLATION, "missing lease token");
        await config.accessEventStore?.record(
          createAccessEvent({
            resourceId: endpoint.id,
            kind: "lease_rejected",
            requestMethod: "GET",
            requestPath: endpoint.wsPath,
            statusCode: 1008,
            errorCode: "missing_lease_token",
          }),
        );
        return;
      }

      let payload;
      try {
        payload = verifyLeaseToken(token, config.leaseTokenSecret);
      } catch (error: unknown) {
        const reason = error instanceof LeaseTokenError ? error.message : "invalid lease token";
        clientConn.close(CLOSE_POLICY_VIOLATION, reason);
        await config.accessEventStore?.record(
          createAccessEvent({
            resourceId: endpoint.id,
            kind: "lease_rejected",
            requestMethod: "GET",
            requestPath: endpoint.wsPath,
            statusCode: 1008,
            errorCode: reason,
          }),
        );
        return;
      }

      cleanupConsumed(Math.floor(Date.now() / 1000));
      if (!config.allowTokenReuse) {
        if (consumedTokens.has(payload.jti)) {
          clientConn.close(CLOSE_POLICY_VIOLATION, "lease token already used");
          await config.accessEventStore?.record(
            createAccessEvent({
              resourceId: endpoint.id,
              kind: "lease_rejected",
              requestMethod: "GET",
              requestPath: endpoint.wsPath,
              statusCode: 1008,
              errorCode: "lease token already used",
            }),
          );
          return;
        }
        consumedTokens.set(payload.jti, payload.exp);
      }

      if (payload.endpointId !== endpoint.id || payload.upstreamWsUrl !== endpoint.upstreamWsUrl) {
        clientConn.close(CLOSE_POLICY_VIOLATION, "lease token endpoint mismatch");
        await config.accessEventStore?.record(
          createAccessEvent({
            resourceId: endpoint.id,
            kind: "lease_rejected",
            requestMethod: "GET",
            requestPath: endpoint.wsPath,
            statusCode: 1008,
            errorCode: "lease token endpoint mismatch",
          }),
        );
        return;
      }

      let upstream: WebSocketConnection;
      try {
        upstream = await connector.connect(endpoint.upstreamWsUrl);
      } catch {
        clientConn.close(CLOSE_INTERNAL_ERROR, "failed to connect upstream");
        return;
      }

      let closed = false;
      const closeBoth = (code?: number, reason?: string): void => {
        if (closed) return;
        closed = true;
        try {
          clientConn.close(code, reason);
        } finally {
          upstream.close(code, reason);
        }
      };

      clientConn.onMessage((data) => {
        if (!closed) upstream.send(data);
      });
      upstream.onMessage((data) => {
        if (!closed) clientConn.send(data);
      });
      clientConn.onError(() => closeBoth(CLOSE_INTERNAL_ERROR, "client websocket error"));
      upstream.onError(() => closeBoth(CLOSE_INTERNAL_ERROR, "upstream websocket error"));
      clientConn.onClose(() => closeBoth());
      upstream.onClose(() => closeBoth());
    });
  }
}

export function webSocketGatewayEndpointsFromResources(resources: X402Resource[]): WebSocketGatewayEndpoint[] {
  return resources
    .filter((resource) => resource.enabled && resource.kind === "websocket")
    .map((resource) => ({
      id: resource.id,
      wsPath: resource.publicPath,
      upstreamWsUrl: resource.upstreamUrl,
    }));
}
