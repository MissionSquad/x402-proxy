import { describe, expect, it, vi } from "vitest";

import { InMemoryX402AccessEventStore } from "../../src/resourceStore";
import type { X402Resource } from "../../src/types";
import {
  installWebSocketGateway,
  webSocketGatewayEndpointsFromResources,
  type UpstreamWebSocketConnector,
  type WebSocketConnection,
  type WebSocketServerAdapter,
} from "../../src/wsGateway";
import { createLeaseToken } from "../../src/wsLease";

const SECRET = "lease-token-secret-with-32-characters";
const ENDPOINT = { id: "trades", wsPath: "/ws/trades", upstreamWsUrl: "wss://upstream/ws/trades" };

class FakeConnection implements WebSocketConnection {
  public readonly sent: Array<string | Buffer> = [];

  public closeCode: number | undefined;

  public closeReason: string | undefined;

  public closeCalls = 0;

  public throwOnSend = false;

  private messageHandler: ((data: string | Buffer) => void) | undefined;

  private closeHandler: (() => void) | undefined;

  private errorHandler: ((error: Error) => void) | undefined;

  send(data: string | Buffer): void {
    if (this.throwOnSend) {
      throw new Error("send failed");
    }
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls += 1;
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
  private readonly handlers = new Map<
    string,
    (query: URLSearchParams, conn: WebSocketConnection) => void
  >();

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
  public constructor(
    private readonly upstream: FakeConnection,
    private readonly fail = false,
  ) {}

  async connect(): Promise<WebSocketConnection> {
    if (this.fail) {
      throw new Error("upstream unreachable");
    }
    return this.upstream;
  }
}

function validToken(overrides: Partial<{ endpointId: string; upstreamWsUrl: string; exp: number; jti: string }> = {}): string {
  return createLeaseToken(
    {
      endpointId: overrides.endpointId ?? ENDPOINT.id,
      exp: overrides.exp ?? Math.floor(Date.now() / 1000) + 60,
      jti: overrides.jti ?? "jti-1",
      upstreamWsUrl: overrides.upstreamWsUrl ?? ENDPOINT.upstreamWsUrl,
    },
    SECRET,
  );
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("installWebSocketGateway", () => {
  it("relays frames in both directions for a valid token", async () => {
    const adapter = new FakeAdapter();
    const upstream = new FakeConnection();
    installWebSocketGateway(adapter, new FakeConnector(upstream), {
      leaseTokenSecret: SECRET,
      endpoints: [ENDPOINT],
    });

    const client = new FakeConnection();
    adapter.connect(ENDPOINT.wsPath, new URLSearchParams({ t: validToken() }), client);
    await tick();

    client.emitMessage("ping");
    upstream.emitMessage("pong");
    expect(upstream.sent).toContain("ping");
    expect(client.sent).toContain("pong");
  });

  it("closes 1008 and records an event when the token is missing", async () => {
    const adapter = new FakeAdapter();
    const events = new InMemoryX402AccessEventStore();
    installWebSocketGateway(adapter, new FakeConnector(new FakeConnection()), {
      leaseTokenSecret: SECRET,
      endpoints: [ENDPOINT],
      accessEventStore: events,
    });

    const client = new FakeConnection();
    adapter.connect(ENDPOINT.wsPath, new URLSearchParams(), client);
    await tick();

    expect(client.closeCode).toBe(1008);
    expect(client.closeReason).toBe("missing lease token");
    expect(events.events[0]?.errorCode).toBe("missing_lease_token");
  });

  it("closes 1008 on an invalid token signature", async () => {
    const adapter = new FakeAdapter();
    installWebSocketGateway(adapter, new FakeConnector(new FakeConnection()), {
      leaseTokenSecret: SECRET,
      endpoints: [ENDPOINT],
    });
    const client = new FakeConnection();
    adapter.connect(ENDPOINT.wsPath, new URLSearchParams({ t: "bad.token" }), client);
    await tick();
    expect(client.closeCode).toBe(1008);
  });

  it("blocks token reuse by default and allows it when configured", async () => {
    const reuseAdapter = new FakeAdapter();
    installWebSocketGateway(reuseAdapter, new FakeConnector(new FakeConnection()), {
      leaseTokenSecret: SECRET,
      endpoints: [ENDPOINT],
    });
    const token = validToken();
    const first = new FakeConnection();
    reuseAdapter.connect(ENDPOINT.wsPath, new URLSearchParams({ t: token }), first);
    await tick();
    const second = new FakeConnection();
    reuseAdapter.connect(ENDPOINT.wsPath, new URLSearchParams({ t: token }), second);
    await tick();
    expect(second.closeCode).toBe(1008);

    const allowAdapter = new FakeAdapter();
    installWebSocketGateway(allowAdapter, new FakeConnector(new FakeConnection()), {
      leaseTokenSecret: SECRET,
      endpoints: [ENDPOINT],
      allowTokenReuse: true,
    });
    const reuseToken = validToken({ jti: "jti-reuse" });
    const a = new FakeConnection();
    const b = new FakeConnection();
    allowAdapter.connect(ENDPOINT.wsPath, new URLSearchParams({ t: reuseToken }), a);
    await tick();
    allowAdapter.connect(ENDPOINT.wsPath, new URLSearchParams({ t: reuseToken }), b);
    await tick();
    expect(b.closeCode).toBeUndefined();
  });

  it("closes 1008 on endpoint id or upstream mismatch", async () => {
    const adapter = new FakeAdapter();
    installWebSocketGateway(adapter, new FakeConnector(new FakeConnection()), {
      leaseTokenSecret: SECRET,
      endpoints: [ENDPOINT],
    });
    const idMismatch = new FakeConnection();
    adapter.connect(
      ENDPOINT.wsPath,
      new URLSearchParams({ t: validToken({ endpointId: "other", jti: "j2" }) }),
      idMismatch,
    );
    await tick();
    expect(idMismatch.closeReason).toBe("lease token endpoint mismatch");

    const urlMismatch = new FakeConnection();
    adapter.connect(
      ENDPOINT.wsPath,
      new URLSearchParams({ t: validToken({ upstreamWsUrl: "wss://other/ws", jti: "j3" }) }),
      urlMismatch,
    );
    await tick();
    expect(urlMismatch.closeReason).toBe("lease token endpoint mismatch");
  });

  it("closes 1011 when the upstream connection fails", async () => {
    const adapter = new FakeAdapter();
    installWebSocketGateway(adapter, new FakeConnector(new FakeConnection(), true), {
      leaseTokenSecret: SECRET,
      endpoints: [ENDPOINT],
    });
    const client = new FakeConnection();
    adapter.connect(ENDPOINT.wsPath, new URLSearchParams({ t: validToken() }), client);
    await tick();
    expect(client.closeCode).toBe(1011);
    expect(client.closeReason).toBe("failed to connect upstream");
  });

  it("closes both sides once on a client error and stops relaying", async () => {
    const adapter = new FakeAdapter();
    const upstream = new FakeConnection();
    installWebSocketGateway(adapter, new FakeConnector(upstream), {
      leaseTokenSecret: SECRET,
      endpoints: [ENDPOINT],
    });
    const client = new FakeConnection();
    adapter.connect(ENDPOINT.wsPath, new URLSearchParams({ t: validToken() }), client);
    await tick();

    client.emitError(new Error("socket reset"));
    expect(client.closeReason).toBe("client websocket error");
    expect(upstream.closeReason).toBe("client websocket error");

    // After close, further frames are not relayed.
    client.emitMessage("late");
    expect(upstream.sent).not.toContain("late");
  });

  it("closes both sides on an upstream error", async () => {
    const adapter = new FakeAdapter();
    const upstream = new FakeConnection();
    installWebSocketGateway(adapter, new FakeConnector(upstream), {
      leaseTokenSecret: SECRET,
      endpoints: [ENDPOINT],
    });
    const client = new FakeConnection();
    adapter.connect(ENDPOINT.wsPath, new URLSearchParams({ t: validToken() }), client);
    await tick();
    upstream.emitError(new Error("upstream reset"));
    expect(client.closeReason).toBe("upstream websocket error");
  });

  it("closeBoth runs once even when both sides close", async () => {
    const adapter = new FakeAdapter();
    const upstream = new FakeConnection();
    installWebSocketGateway(adapter, new FakeConnector(upstream), {
      leaseTokenSecret: SECRET,
      endpoints: [ENDPOINT],
    });
    const client = new FakeConnection();
    adapter.connect(ENDPOINT.wsPath, new URLSearchParams({ t: validToken() }), client);
    await tick();
    client.close();
    upstream.close();
    // Each side is closed at most twice total (its own close + the propagated closeBoth).
    expect(client.closeCalls).toBeLessThanOrEqual(2);
  });

  it("tears down the relay when a send throws", async () => {
    const adapter = new FakeAdapter();
    const upstream = new FakeConnection();
    upstream.throwOnSend = true;
    installWebSocketGateway(adapter, new FakeConnector(upstream), {
      leaseTokenSecret: SECRET,
      endpoints: [ENDPOINT],
    });
    const client = new FakeConnection();
    adapter.connect(ENDPOINT.wsPath, new URLSearchParams({ t: validToken() }), client);
    await tick();
    expect(() => client.emitMessage("data")).not.toThrow();
    expect(client.closeReason).toBe("upstream send failed");
  });
});

describe("webSocketGatewayEndpointsFromResources", () => {
  it("maps enabled websocket resources only", () => {
    const resources: X402Resource[] = [
      {
        id: "ws1",
        enabled: true,
        kind: "websocket",
        method: "GET",
        publicPath: "/ws/a",
        upstreamUrl: "wss://u/a",
        pricing: { amount: "0.01", network: "eip155:8453", payTo: "0xPayee" },
        stream: { leasePath: "/ws/a/lease", leaseSeconds: 60, allowRenewal: false, renewalWindowSeconds: 0 },
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "http1",
        enabled: true,
        kind: "http",
        method: "GET",
        publicPath: "/api/x",
        upstreamUrl: "https://u/x",
        pricing: { amount: "0.01", network: "eip155:8453", payTo: "0xPayee" },
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: "ws2",
        enabled: false,
        kind: "websocket",
        method: "GET",
        publicPath: "/ws/b",
        upstreamUrl: "wss://u/b",
        pricing: { amount: "0.01", network: "eip155:8453", payTo: "0xPayee" },
        stream: { leasePath: "/ws/b/lease", leaseSeconds: 60, allowRenewal: false, renewalWindowSeconds: 0 },
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    expect(webSocketGatewayEndpointsFromResources(resources)).toEqual([
      { id: "ws1", wsPath: "/ws/a", upstreamWsUrl: "wss://u/a" },
    ]);
  });
});
