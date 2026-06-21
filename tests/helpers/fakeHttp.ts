import { EventEmitter } from "node:events";

/**
 * Minimal Express-compatible Response double that records everything the proxy writes and
 * lets tests drive backpressure (write() return value) and the drain event.
 */
export class FakeResponse extends EventEmitter {
  public statusCode = 200;

  public readonly headers: Record<string, string> = {};

  public body: unknown;

  public sentBuffer: Buffer | undefined;

  public ended = false;

  public writableEnded = false;

  public headersSent = false;

  public readonly chunks: Buffer[] = [];

  /** When false, write() reports backpressure until a drain event is emitted. */
  public writeReturns = true;

  public status(code: number): this {
    this.statusCode = code;
    return this;
  }

  public setHeader(name: string, value: string): this {
    this.headers[name.toLowerCase()] = value;
    return this;
  }

  public getHeader(name: string): string | undefined {
    return this.headers[name.toLowerCase()];
  }

  public json(payload: unknown): this {
    this.headersSent = true;
    this.writableEnded = true;
    this.ended = true;
    this.body = payload;
    return this;
  }

  public send(payload: Buffer | string): this {
    this.headersSent = true;
    this.writableEnded = true;
    this.ended = true;
    this.sentBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
    this.body = payload;
    return this;
  }

  public write(chunk: Buffer | Uint8Array): boolean {
    this.headersSent = true;
    this.chunks.push(Buffer.from(chunk));
    return this.writeReturns;
  }

  public end(): this {
    this.writableEnded = true;
    this.ended = true;
    return this;
  }

  /** Concatenated streamed chunks. */
  public get streamedBody(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

export type FakeRequestInit = {
  method?: string;
  originalUrl?: string;
  protocol?: string;
  headers?: Record<string, string | string[] | undefined>;
  query?: Record<string, unknown>;
  body?: unknown;
  /** Raw request stream chunks used when body is undefined. */
  bodyChunks?: Array<Buffer | string>;
};

export type FakeRequest = {
  method: string;
  originalUrl: string;
  protocol: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
  body: unknown;
  get(name: string): string | undefined;
  on(event: string, handler: (...args: unknown[]) => void): void;
  once(event: string, handler: (...args: unknown[]) => void): void;
  off(event: string, handler: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): boolean;
  [Symbol.asyncIterator](): AsyncGenerator<Buffer>;
};

export function createFakeRequest(init: FakeRequestInit = {}): FakeRequest {
  const emitter = new EventEmitter();
  const headers = init.headers ?? {};
  const originalUrl = init.originalUrl ?? "/";
  const chunks = init.bodyChunks;

  return {
    method: init.method ?? "GET",
    originalUrl,
    protocol: init.protocol ?? "http",
    path: originalUrl.split("?")[0] ?? originalUrl,
    headers,
    query: init.query ?? {},
    body: init.body,
    get(name: string): string | undefined {
      const value = headers[name.toLowerCase()];
      return Array.isArray(value) ? value[0] : value;
    },
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    off: emitter.off.bind(emitter),
    emit: emitter.emit.bind(emitter),
    async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
      for (const chunk of chunks ?? []) {
        yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      }
    },
  };
}

/** Build a fetch Response whose body streams the given string chunks. */
export function streamingResponse(
  chunks: string[],
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller): void {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: init.status ?? 200, headers: init.headers ?? {} });
}

export function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
