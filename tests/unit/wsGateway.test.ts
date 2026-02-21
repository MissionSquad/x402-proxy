import { describe, expect, it } from "vitest";

import {
  installWebSocketGateway,
  type UpstreamWebSocketConnector,
  type WebSocketConnection,
  type WebSocketServerAdapter,
} from "../../src/wsGateway";
import { createLeaseToken } from "../../src/wsLease";

class FakeConnection implements WebSocketConnection {
  public readonly sent: Array<string | Buffer> = [];

  public closeCode: number | undefined;

  public closeReason: string | undefined;

  private messageHandler: ((data: string | Buffer) => void) | undefined;

  private closeHandler: (() => void) | undefined;

  private errorHandler: ((error: Error) => void) | undefined;

  send(data: string | Buffer): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCode = code;
    this.closeReason = reason;
    this.closeHandler?.();
  }

  onMessage(handler: (data: string | Buffer) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }

  emitMessage(data: string | Buffer): void {
    this.messageHandler?.(data);
  }

  emitError(error: Error): void {
    this.errorHandler?.(error);
  }
}

class FakeAdapter implements WebSocketServerAdapter {
  private readonly handlers = new Map<string, (query: URLSearchParams, conn: WebSocketConnection) => void>();

  onConnection(path: string, handler: (query: URLSearchParams, conn: WebSocketConnection) => void): void {
    this.handlers.set(path, handler);
  }

  connect(path: string, query: URLSearchParams, conn: WebSocketConnection): void {
    const handler = this.handlers.get(path);
    if (!handler) {
      throw new Error(`No handler for path ${path}`);
    }
    handler(query, conn);
  }
}

class FakeConnector implements UpstreamWebSocketConnector {
  public constructor(private readonly upstream: FakeConnection) {}

  async connect(): Promise<WebSocketConnection> {
    return this.upstream;
  }
}

describe("installWebSocketGateway", () => {
  it("relays frames for valid token and blocks token reuse", async () => {
    const secret = "lease-token-secret-with-32-characters";
    const adapter = new FakeAdapter();
    const upstream = new FakeConnection();

    installWebSocketGateway(adapter, new FakeConnector(upstream), {
      leaseTokenSecret: secret,
      endpoints: [{ id: "trades", wsPath: "/ws/trades", upstreamWsUrl: "wss://upstream/ws/trades" }],
    });

    const token = createLeaseToken(
      {
        endpointId: "trades",
        exp: Math.floor(Date.now() / 1000) + 60,
        jti: "lease-1",
        upstreamWsUrl: "wss://upstream/ws/trades",
      },
      secret,
    );

    const client = new FakeConnection();
    adapter.connect("/ws/trades", new URLSearchParams({ t: token }), client);
    await new Promise((resolve) => setImmediate(resolve));

    client.emitMessage("ping");
    expect(upstream.sent).toContain("ping");

    upstream.emitMessage("pong");
    expect(client.sent).toContain("pong");

    const secondClient = new FakeConnection();
    adapter.connect("/ws/trades", new URLSearchParams({ t: token }), secondClient);
    await new Promise((resolve) => setImmediate(resolve));
    expect(secondClient.closeCode).toBe(1008);
  });
});
