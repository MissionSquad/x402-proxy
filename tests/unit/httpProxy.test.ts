import { lookup } from "node:dns/promises";

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import {
  RequestBodyTooLargeError,
  SecurityPolicyError,
  UpstreamRequestError,
} from "../../src/errors";
import {
  assertUpstreamAllowed,
  createHttpProxyHandler,
  proxyBufferedHttpRequest,
  proxyStreamingHttpRequest,
  sendBufferedProxyResponse,
  type EffectiveSecurityPolicy,
} from "../../src/httpProxy";
import type { HttpProxyEndpointConfig } from "../../src/types";
import { createFakeRequest, FakeResponse, nextTick, streamingResponse } from "../helpers/fakeHttp";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

const lookupMock = lookup as unknown as Mock;

let fetchMock: Mock;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  lookupMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const PRIVATE_POLICY: EffectiveSecurityPolicy = {
  allowInsecureHttpUpstream: true,
  allowPrivateIpUpstreams: false,
};

async function expectBlocked(url: string): Promise<void> {
  await expect(assertUpstreamAllowed(new URL(url), PRIVATE_POLICY)).rejects.toBeInstanceOf(
    SecurityPolicyError,
  );
}

async function expectAllowed(url: string): Promise<void> {
  await expect(assertUpstreamAllowed(new URL(url), PRIVATE_POLICY)).resolves.toBeUndefined();
}

describe("assertUpstreamAllowed - protocol + private host policy", () => {
  it("rejects insecure http upstreams when not allowed", async () => {
    await expect(
      assertUpstreamAllowed(new URL("http://example.com"), {
        allowInsecureHttpUpstream: false,
        allowPrivateIpUpstreams: true,
      }),
    ).rejects.toThrow(/Insecure HTTP upstreams are disabled/);
  });

  it("allows https when insecure http is disabled", async () => {
    await expect(
      assertUpstreamAllowed(new URL("https://example.com"), {
        allowInsecureHttpUpstream: false,
        allowPrivateIpUpstreams: true,
      }),
    ).resolves.toBeUndefined();
  });

  it("short-circuits entirely when private upstreams are allowed", async () => {
    await expect(
      assertUpstreamAllowed(new URL("http://127.0.0.1"), {
        allowInsecureHttpUpstream: true,
        allowPrivateIpUpstreams: true,
      }),
    ).resolves.toBeUndefined();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("rejects the literal localhost hostname (any case)", async () => {
    await expectBlocked("https://localhost/x");
    await expectBlocked("https://LOCALHOST/x");
  });
});

describe("assertUpstreamAllowed - IPv4 literal classification", () => {
  const blocked = [
    "10.1.2.3",
    "127.0.0.1",
    "0.0.0.0",
    "169.254.1.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "224.0.0.1",
    "239.255.255.255",
    "100.64.0.1",
    "100.127.255.255",
  ];
  const allowed = ["172.15.0.1", "172.32.0.1", "100.63.0.1", "100.128.0.1", "8.8.8.8", "1.1.1.1"];

  it.each(blocked)("blocks private/reserved IPv4 %s", async (ip) => {
    await expectBlocked(`https://${ip}/`);
  });

  it.each(allowed)("allows public IPv4 %s without DNS lookup", async (ip) => {
    await expectAllowed(`https://${ip}/`);
    expect(lookupMock).not.toHaveBeenCalled();
  });
});

describe("assertUpstreamAllowed - IPv6 literal classification", () => {
  const blocked = [
    "[::1]",
    "[::]",
    "[fc00::1]",
    "[fd12::1]",
    "[fe80::1]",
    "[fec0::1]",
    "[64:ff9b::1]",
    "[::ffff:127.0.0.1]", // normalized by URL to ::ffff:7f00:1
    "[::ffff:10.0.0.1]",
    "[::ffff:169.254.169.254]", // cloud IMDS via IPv4-mapped IPv6
  ];

  it.each(blocked)("blocks private/mapped IPv6 %s", async (ip) => {
    await expectBlocked(`https://${ip}/`);
  });

  it("allows public IPv6", async () => {
    await expectAllowed("https://[2606:4700:4700::1111]/");
  });
});

describe("assertUpstreamAllowed - DNS resolution path", () => {
  it("rejects when a resolved address is private", async () => {
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await expect(assertUpstreamAllowed(new URL("https://evil.test/"), PRIVATE_POLICY)).rejects.toThrow(
      SecurityPolicyError,
    );
  });

  it("throws UpstreamRequestError when the host does not resolve", async () => {
    lookupMock.mockResolvedValue([]);
    await expect(assertUpstreamAllowed(new URL("https://nowhere.test/"), PRIVATE_POLICY)).rejects.toThrow(
      UpstreamRequestError,
    );
  });

  it("allows when every resolved address is public", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    await expect(
      assertUpstreamAllowed(new URL("https://example.test/"), PRIVATE_POLICY),
    ).resolves.toBeUndefined();
  });

  it("blocks when a resolved address is not a recognizable IP (fail closed)", async () => {
    lookupMock.mockResolvedValue([{ address: "not-an-ip", family: 0 }]);
    await expect(
      assertUpstreamAllowed(new URL("https://weird.test/"), PRIVATE_POLICY),
    ).rejects.toThrow(SecurityPolicyError);
  });
});

function okResponse(body = "ok", headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers });
}

const target = { id: "t", method: "POST" as const, upstreamUrl: "https://upstream.test/api" };

describe("request body handling", () => {
  it("streams a raw request body when no parser ran", async () => {
    fetchMock.mockResolvedValue(okResponse());
    await proxyBufferedHttpRequest({
      target,
      req: createFakeRequest({ method: "POST", bodyChunks: ["ab", "cd"] }) as never,
      res: new FakeResponse() as never,
      securityConfig: { allowPrivateIpUpstreams: true },
    });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(Buffer.from(init.body as Uint8Array).toString()).toBe("abcd");
  });

  it("returns no body for an empty raw stream and for GET", async () => {
    fetchMock.mockResolvedValue(okResponse());
    await proxyBufferedHttpRequest({
      target,
      req: createFakeRequest({ method: "POST", bodyChunks: [] }) as never,
      res: new FakeResponse() as never,
      securityConfig: { allowPrivateIpUpstreams: true },
    });
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).body).toBeUndefined();

    fetchMock.mockResolvedValue(okResponse());
    await proxyBufferedHttpRequest({
      target: { ...target, method: "GET" },
      req: createFakeRequest({ method: "GET" }) as never,
      res: new FakeResponse() as never,
      securityConfig: { allowPrivateIpUpstreams: true },
    });
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).body).toBeUndefined();
  });

  it("passes through Buffer / string / Uint8Array parsed bodies verbatim", async () => {
    const cases: Array<{ body: unknown; expected: string }> = [
      { body: Buffer.from("buf"), expected: "buf" },
      { body: "plain", expected: "plain" },
      { body: new Uint8Array([104, 105]), expected: "hi" },
    ];
    for (const { body, expected } of cases) {
      fetchMock.mockResolvedValue(okResponse());
      await proxyBufferedHttpRequest({
        target,
        req: createFakeRequest({ method: "POST", body }) as never,
        res: new FakeResponse() as never,
        securityConfig: { allowPrivateIpUpstreams: true },
      });
      const sent = (fetchMock.mock.calls.at(-1)?.[1] as RequestInit).body;
      const text = typeof sent === "string" ? sent : Buffer.from(sent as Uint8Array).toString();
      expect(text).toBe(expected);
    }
  });

  it("serializes a parsed object as JSON by default", async () => {
    fetchMock.mockResolvedValue(okResponse());
    await proxyBufferedHttpRequest({
      target,
      req: createFakeRequest({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: { a: 1 },
      }) as never,
      res: new FakeResponse() as never,
      securityConfig: { allowPrivateIpUpstreams: true },
    });
    const sent = (fetchMock.mock.calls[0]?.[1] as RequestInit).body as Uint8Array;
    expect(Buffer.from(sent).toString()).toBe(JSON.stringify({ a: 1 }));
  });

  it("re-encodes a parsed object as urlencoded when the content-type says so", async () => {
    fetchMock.mockResolvedValue(okResponse());
    await proxyBufferedHttpRequest({
      target,
      req: createFakeRequest({
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: { a: "1", b: "two words" },
      }) as never,
      res: new FakeResponse() as never,
      securityConfig: { allowPrivateIpUpstreams: true },
    });
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).body).toBe("a=1&b=two+words");
  });

  it("rejects a raw body that exceeds maxRequestBodyBytes with HTTP 413", async () => {
    fetchMock.mockResolvedValue(okResponse());
    await expect(
      proxyBufferedHttpRequest({
        target,
        req: createFakeRequest({ method: "POST", bodyChunks: ["aaaa", "bbbb"] }) as never,
        res: new FakeResponse() as never,
        securityConfig: { allowPrivateIpUpstreams: true, maxRequestBodyBytes: 4 },
      }),
    ).rejects.toThrow(RequestBodyTooLargeError);
  });
});

describe("timeout resolution", () => {
  it("uses each timeout source without error", async () => {
    for (const securityConfig of [
      { allowPrivateIpUpstreams: true, upstreamTimeoutMs: 5000 },
      { allowPrivateIpUpstreams: true },
    ]) {
      fetchMock.mockResolvedValue(okResponse());
      await proxyBufferedHttpRequest({
        target: { ...target, maxTimeoutSeconds: 2 },
        req: createFakeRequest({ method: "POST", bodyChunks: ["x"] }) as never,
        res: new FakeResponse() as never,
        securityConfig,
      });
    }
    // No maxTimeoutSeconds and no override -> default branch.
    fetchMock.mockResolvedValue(okResponse());
    await proxyBufferedHttpRequest({
      target,
      req: createFakeRequest({ method: "POST", bodyChunks: ["x"] }) as never,
      res: new FakeResponse() as never,
      securityConfig: { allowPrivateIpUpstreams: true },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("sendBufferedProxyResponse", () => {
  it("forwards status, body and upstream content-type by default", async () => {
    const res = new FakeResponse();
    await sendBufferedProxyResponse(res as never, {
      status: 201,
      response: new Response("hello", { headers: { "content-type": "text/plain" } }),
      body: Buffer.from("hello"),
    });
    expect(res.statusCode).toBe(201);
    expect(res.sentBuffer?.toString()).toBe("hello");
    expect(res.headers["content-type"]).toBe("text/plain");
  });
});

describe("proxyStreamingHttpRequest", () => {
  it("ends immediately when the upstream has no body", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const res = new FakeResponse();
    await proxyStreamingHttpRequest({
      target: { ...target },
      req: createFakeRequest({ method: "POST", bodyChunks: ["x"] }) as never,
      res: res as never,
      securityConfig: { allowPrivateIpUpstreams: true },
    });
    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
    expect(res.chunks).toHaveLength(0);
  });

  it("relays stream chunks and ends", async () => {
    fetchMock.mockResolvedValue(streamingResponse(["data: a\n", "data: b\n"]));
    const res = new FakeResponse();
    await proxyStreamingHttpRequest({
      target,
      req: createFakeRequest({ method: "POST" }) as never,
      res: res as never,
      securityConfig: { allowPrivateIpUpstreams: true },
    });
    expect(res.streamedBody).toBe("data: a\ndata: b\n");
    expect(res.ended).toBe(true);
  });

  it("waits for drain when the client applies backpressure", async () => {
    fetchMock.mockResolvedValue(streamingResponse(["one", "two"]));
    const res = new FakeResponse();
    res.writeReturns = false;
    const promise = proxyStreamingHttpRequest({
      target,
      req: createFakeRequest({ method: "POST" }) as never,
      res: res as never,
      securityConfig: { allowPrivateIpUpstreams: true },
    });
    await nextTick();
    res.writeReturns = true;
    res.emit("drain");
    await promise;
    expect(res.streamedBody).toBe("onetwo");
  });

  it("returns quietly when the client disconnects before the upstream responds", async () => {
    const req = createFakeRequest({ method: "POST" });
    fetchMock.mockImplementation(async () => {
      req.emit("close");
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    });
    const res = new FakeResponse();
    await expect(
      proxyStreamingHttpRequest({
        target,
        req: req as never,
        res: res as never,
        securityConfig: { allowPrivateIpUpstreams: true },
      }),
    ).resolves.toBeUndefined();
    expect(res.headersSent).toBe(false);
  });

  it("stops relaying once the client disconnects mid-stream", async () => {
    let enqueueSecond: () => void = () => undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode("first"));
        enqueueSecond = (): void => {
          controller.enqueue(new TextEncoder().encode("second"));
          controller.close();
        };
      },
    });
    fetchMock.mockResolvedValue(new Response(stream, { status: 200 }));
    const req = createFakeRequest({ method: "POST" });
    const res = new FakeResponse();
    const promise = proxyStreamingHttpRequest({
      target,
      req: req as never,
      res: res as never,
      securityConfig: { allowPrivateIpUpstreams: true },
    });
    await nextTick();
    req.emit("close");
    enqueueSecond();
    await promise;
    expect(res.streamedBody).toBe("first");
  });

  it("rethrows a non-abort relay failure even after the client disconnects", async () => {
    let failSecond: () => void = () => undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode("first"));
        failSecond = (): void => {
          controller.error(new Error("reader exploded"));
        };
      },
    });
    fetchMock.mockResolvedValue(new Response(stream, { status: 200 }));
    const req = createFakeRequest({ method: "POST" });
    const promise = proxyStreamingHttpRequest({
      target,
      req: req as never,
      res: new FakeResponse() as never,
      securityConfig: { allowPrivateIpUpstreams: true },
    });
    await nextTick();
    req.emit("close");
    failSecond();
    await expect(promise).rejects.toThrow("reader exploded");
  });

  it("swallows only the abort rejection after a client disconnect", async () => {
    let abortSecond: () => void = () => undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode("first"));
        abortSecond = (): void => {
          const error = new Error("aborted");
          error.name = "AbortError";
          controller.error(error);
        };
      },
    });
    fetchMock.mockResolvedValue(new Response(stream, { status: 200 }));
    const req = createFakeRequest({ method: "POST" });
    const res = new FakeResponse();
    const promise = proxyStreamingHttpRequest({
      target,
      req: req as never,
      res: res as never,
      securityConfig: { allowPrivateIpUpstreams: true },
    });
    await nextTick();
    req.emit("close");
    abortSecond();
    await expect(promise).resolves.toBeUndefined();
    expect(res.streamedBody).toBe("first");
  });

  it("rethrows a non-client-close fetch failure", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    await expect(
      proxyStreamingHttpRequest({
        target,
        req: createFakeRequest({ method: "POST" }) as never,
        res: new FakeResponse() as never,
        securityConfig: { allowPrivateIpUpstreams: true },
      }),
    ).rejects.toThrow(/network down/);
  });
});

const endpoint: HttpProxyEndpointConfig = {
  kind: "http",
  id: "endpoint-1",
  method: "GET",
  publicPath: "/p",
  upstreamUrl: "https://upstream.test/api",
  price: "0.01",
};

describe("createHttpProxyHandler", () => {
  it("proxies a successful response and forwards content-type", async () => {
    fetchMock.mockResolvedValue(okResponse('{"ok":true}', { "content-type": "application/json" }));
    const res = new FakeResponse();
    const handler = createHttpProxyHandler(endpoint, { allowPrivateIpUpstreams: true });
    await handler(createFakeRequest({ method: "GET", originalUrl: "/p" }) as never, res as never, vi.fn());
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(res.sentBuffer?.toString()).toBe('{"ok":true}');
  });

  it("forwards a request body on POST", async () => {
    fetchMock.mockResolvedValue(okResponse());
    const handler = createHttpProxyHandler({ ...endpoint, method: "POST" }, { allowPrivateIpUpstreams: true });
    await handler(
      createFakeRequest({ method: "POST", originalUrl: "/p", bodyChunks: ["payload"] }) as never,
      new FakeResponse() as never,
      vi.fn(),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(Buffer.from(init.body as Uint8Array).toString()).toBe("payload");
  });

  it("relays an upstream redirect instead of following it", async () => {
    fetchMock.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "https://elsewhere.test/" } }),
    );
    const res = new FakeResponse();
    const handler = createHttpProxyHandler(endpoint, { allowPrivateIpUpstreams: true });
    await handler(createFakeRequest({ method: "GET", originalUrl: "/p" }) as never, res as never, vi.fn());
    expect(res.statusCode).toBe(302);
    expect(res.headers["location"]).toBe("https://elsewhere.test/");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("returns 403 on a security policy violation", async () => {
    const res = new FakeResponse();
    const handler = createHttpProxyHandler(
      { ...endpoint, upstreamUrl: "https://10.0.0.1/x" },
      { allowPrivateIpUpstreams: false },
    );
    await handler(createFakeRequest({ method: "GET", originalUrl: "/p" }) as never, res as never, vi.fn());
    expect(res.statusCode).toBe(403);
    expect((res.body as { code: string }).code).toBe("SECURITY_POLICY_ERROR");
  });

  it("returns 413 when the request body is too large", async () => {
    const res = new FakeResponse();
    const handler = createHttpProxyHandler(
      { ...endpoint, method: "POST" },
      { allowPrivateIpUpstreams: true, maxRequestBodyBytes: 2 },
    );
    await handler(
      createFakeRequest({ method: "POST", originalUrl: "/p", bodyChunks: ["toolong"] }) as never,
      res as never,
      vi.fn(),
    );
    expect(res.statusCode).toBe(413);
    expect((res.body as { code: string }).code).toBe("REQUEST_BODY_TOO_LARGE_ERROR");
  });

  it("returns 504 on an abort", async () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    fetchMock.mockRejectedValue(error);
    const res = new FakeResponse();
    const handler = createHttpProxyHandler(endpoint, { allowPrivateIpUpstreams: true });
    await handler(createFakeRequest({ method: "GET", originalUrl: "/p" }) as never, res as never, vi.fn());
    expect(res.statusCode).toBe(504);
    expect((res.body as { code: string }).code).toBe("UPSTREAM_TIMEOUT_ERROR");
  });

  it("returns 502 on an UpstreamRequestError (unresolvable host)", async () => {
    lookupMock.mockResolvedValue([]);
    const res = new FakeResponse();
    const handler = createHttpProxyHandler(
      { ...endpoint, upstreamUrl: "https://unresolved.test/x" },
      { allowPrivateIpUpstreams: false },
    );
    await handler(createFakeRequest({ method: "GET", originalUrl: "/p" }) as never, res as never, vi.fn());
    expect(res.statusCode).toBe(502);
    expect((res.body as { code: string }).code).toBe("UPSTREAM_REQUEST_ERROR");
  });

  it("forwards unknown errors to next with a cause string", async () => {
    fetchMock.mockRejectedValue(new Error("boom"));
    const next = vi.fn();
    const handler = createHttpProxyHandler(endpoint, { allowPrivateIpUpstreams: true });
    await handler(createFakeRequest({ method: "GET", originalUrl: "/p" }) as never, new FakeResponse() as never, next);
    expect(next).toHaveBeenCalledTimes(1);
    const error = next.mock.calls[0]?.[0] as UpstreamRequestError;
    expect(error).toBeInstanceOf(UpstreamRequestError);
    expect(error.context?.cause).toBe("boom");
  });

  it("forwards non-Error throwables to next with an unknown cause", async () => {
    fetchMock.mockRejectedValue("string failure");
    const next = vi.fn();
    const handler = createHttpProxyHandler(endpoint, { allowPrivateIpUpstreams: true });
    await handler(createFakeRequest({ method: "GET", originalUrl: "/p" }) as never, new FakeResponse() as never, next);
    const error = next.mock.calls[0]?.[0] as UpstreamRequestError;
    expect(error.context?.cause).toBe("unknown");
  });

  it("merges incoming query params into the upstream URL", async () => {
    fetchMock.mockResolvedValue(okResponse());
    const handler = createHttpProxyHandler(
      { ...endpoint, upstreamUrl: "https://upstream.test/api?fixed=1" },
      { allowPrivateIpUpstreams: true },
    );
    await handler(
      createFakeRequest({ method: "GET", originalUrl: "/p?extra=2" }) as never,
      new FakeResponse() as never,
      vi.fn(),
    );
    const url = fetchMock.mock.calls[0]?.[0] as URL;
    expect(url.searchParams.get("fixed")).toBe("1");
    expect(url.searchParams.get("extra")).toBe("2");
  });
});
