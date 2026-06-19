import { describe, expect, it } from "vitest";

import { RouteBuildError } from "../../src/errors";
import {
  findBestRouteMatch,
  interpolateUpstreamUrl,
  matchRoutePattern,
  parseRoutePattern,
} from "../../src/routePattern";

describe("routePattern", () => {
  it("extracts named params from [param] segments", () => {
    const pattern = parseRoutePattern("/paid/agents/[username]/[slug]/chat");
    const match = matchRoutePattern(pattern, "/paid/agents/jayson/research/chat");

    expect(match?.params).toEqual({ username: "jayson", slug: "research" });
  });

  it("rejects duplicate params and middle wildcards", () => {
    expect(() => parseRoutePattern("/a/[id]/[id]")).toThrow(RouteBuildError);
    expect(() => parseRoutePattern("/a/*/c", { allowWildcard: true })).toThrow(RouteBuildError);
  });

  it("uses deterministic precedence for exact, param, and wildcard routes", () => {
    const candidates = [
      { id: "wildcard", routePattern: parseRoutePattern("/paid/agents/*", { allowWildcard: true }) },
      { id: "param", routePattern: parseRoutePattern("/paid/agents/[username]/chat") },
      { id: "exact", routePattern: parseRoutePattern("/paid/agents/health/chat") },
    ];

    expect(findBestRouteMatch(candidates, "/paid/agents/health/chat")?.candidate.id).toBe("exact");
    expect(findBestRouteMatch(candidates, "/paid/agents/jayson/chat")?.candidate.id).toBe("param");
    expect(findBestRouteMatch(candidates, "/paid/agents/jayson/other")?.candidate.id).toBe("wildcard");
  });

  it("interpolates upstream path params and preserves inbound query params", () => {
    const url = interpolateUpstreamUrl(
      "https://upstream.example.com/v1/[username]/[slug]/chat?fixed=1",
      { username: "jay son", slug: "agent/one" },
      "/paid/jay%20son/agent%2Fone/chat?stream=true",
    );

    expect(url.toString()).toBe(
      "https://upstream.example.com/v1/jay%20son/agent%2Fone/chat?fixed=1&stream=true",
    );
  });
});
