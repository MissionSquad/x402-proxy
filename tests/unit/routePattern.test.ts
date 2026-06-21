import { describe, expect, it } from "vitest";

import { RouteBuildError } from "../../src/errors";
import {
  extractRoutePlaceholders,
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

  it("rejects malformed patterns", () => {
    expect(() => parseRoutePattern("noslash")).toThrow(RouteBuildError);
    expect(() => parseRoutePattern("/a?b")).toThrow(RouteBuildError);
    expect(() => parseRoutePattern("/a#b")).toThrow(RouteBuildError);
    expect(() => parseRoutePattern("/a/")).toThrow(RouteBuildError);
    expect(() => parseRoutePattern("/a//b")).toThrow(RouteBuildError);
    expect(() => parseRoutePattern("/a/]bad[")).toThrow(RouteBuildError);
    expect(() => parseRoutePattern("/a/*", { allowWildcard: false })).toThrow(RouteBuildError);
  });

  it("parses the root pattern with no segments", () => {
    expect(parseRoutePattern("/").segments).toEqual([]);
  });

  it("returns null for non-matching paths and bad encodings", () => {
    const pattern = parseRoutePattern("/[id]");
    expect(matchRoutePattern(pattern, "noslash")).toBeNull();
    expect(matchRoutePattern(pattern, "/%E0%A4%A")).toBeNull(); // undecodable
    expect(matchRoutePattern(pattern, "/%2F")).toBeNull(); // decodes to a slash
    expect(matchRoutePattern(parseRoutePattern("/a/b"), "/a")).toBeNull(); // length mismatch
    const wildcard = parseRoutePattern("/a/b/*", { allowWildcard: true });
    expect(matchRoutePattern(wildcard, "/a")).toBeNull(); // shorter than required
  });

  it("breaks precedence ties by segment length and pattern string", () => {
    const candidates = [
      { id: "short", routePattern: parseRoutePattern("/a/[x]") },
      { id: "long", routePattern: parseRoutePattern("/a/[x]/[y]") },
    ];
    expect(findBestRouteMatch(candidates, "/a/one/two")?.candidate.id).toBe("long");

    const sameShape = [
      { id: "b-pattern", routePattern: parseRoutePattern("/b/[x]") },
      { id: "a-pattern", routePattern: parseRoutePattern("/a/[x]") },
    ];
    expect(findBestRouteMatch(sameShape, "/a/one")?.candidate.id).toBe("a-pattern");
    expect(findBestRouteMatch(candidates, "/nope/x")).toBeNull();
  });

  it("prefers a non-wildcard route over a wildcard of equal literal depth", () => {
    const candidates = [
      { id: "wildcard", routePattern: parseRoutePattern("/a/*", { allowWildcard: true }) },
      { id: "param", routePattern: parseRoutePattern("/a/[x]") },
    ];
    expect(findBestRouteMatch(candidates, "/a/value")?.candidate.id).toBe("param");
  });

  it("extracts placeholder names from a string", () => {
    expect(extractRoutePlaceholders("/a/[x]/[y]/static")).toEqual(["x", "y"]);
    expect(extractRoutePlaceholders("/a/static")).toEqual([]);
  });

  it("throws when a required upstream parameter is missing", () => {
    expect(() => interpolateUpstreamUrl("https://u/[missing]", {}, "/x")).toThrow(RouteBuildError);
  });
});
