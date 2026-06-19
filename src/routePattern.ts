import { RouteBuildError } from "./errors";

export type RoutePatternSegment =
  | { kind: "literal"; value: string }
  | { kind: "param"; name: string }
  | { kind: "wildcard" };

export type CompiledRoutePattern = {
  pattern: string;
  segments: RoutePatternSegment[];
  paramNames: string[];
  wildcard: boolean;
  literalCount: number;
};

export type RouteMatch = {
  pattern: CompiledRoutePattern;
  params: Record<string, string>;
};

export type ParseRoutePatternOptions = {
  allowWildcard?: boolean;
};

const PARAM_SEGMENT_REGEX = /^\[([A-Za-z_][A-Za-z0-9_]*)\]$/;

function splitPath(path: string): string[] {
  if (path === "/") {
    return [];
  }
  return path.slice(1).split("/");
}

function decodePathSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export function parseRoutePattern(
  pattern: string,
  options: ParseRoutePatternOptions = {},
): CompiledRoutePattern {
  if (!pattern.startsWith("/")) {
    throw new RouteBuildError("Route pattern must start with /", { pattern });
  }
  if (pattern.includes("?") || pattern.includes("#")) {
    throw new RouteBuildError("Route pattern must not include query or hash", { pattern });
  }
  if (pattern.length > 1 && pattern.endsWith("/")) {
    throw new RouteBuildError("Route pattern must not end with /", { pattern });
  }

  const rawSegments = splitPath(pattern);
  const segments: RoutePatternSegment[] = [];
  const paramNames: string[] = [];
  const seenParams = new Set<string>();
  let wildcard = false;
  let literalCount = 0;

  rawSegments.forEach((segment, index) => {
    if (!segment) {
      throw new RouteBuildError("Route pattern must not contain empty segments", { pattern });
    }

    if (segment === "*") {
      if (!options.allowWildcard) {
        throw new RouteBuildError("Wildcard route segments are disabled", { pattern });
      }
      if (index !== rawSegments.length - 1) {
        throw new RouteBuildError("Wildcard route segment must be the final segment", { pattern });
      }
      wildcard = true;
      segments.push({ kind: "wildcard" });
      return;
    }

    const paramMatch = PARAM_SEGMENT_REGEX.exec(segment);
    if (paramMatch) {
      const name = paramMatch[1];
      if (!name) {
        throw new RouteBuildError("Route parameter name is empty", { pattern });
      }
      if (seenParams.has(name)) {
        throw new RouteBuildError("Route pattern contains duplicate parameter name", {
          pattern,
          parameter: name,
        });
      }
      seenParams.add(name);
      paramNames.push(name);
      segments.push({ kind: "param", name });
      return;
    }

    if (segment.includes("[") || segment.includes("]")) {
      throw new RouteBuildError("Route parameter segments must use [name] syntax", { pattern });
    }

    literalCount += 1;
    segments.push({ kind: "literal", value: segment });
  });

  return {
    pattern,
    segments,
    paramNames,
    wildcard,
    literalCount,
  };
}

export function matchRoutePattern(pattern: CompiledRoutePattern, path: string): RouteMatch | null {
  if (!path.startsWith("/")) {
    return null;
  }
  const pathOnly = path.split("?")[0] ?? path;
  const rawSegments = splitPath(pathOnly);
  const requiredLength = pattern.wildcard ? pattern.segments.length - 1 : pattern.segments.length;
  if (pattern.wildcard) {
    if (rawSegments.length < requiredLength) {
      return null;
    }
  } else if (rawSegments.length !== pattern.segments.length) {
    return null;
  }

  const params: Record<string, string> = {};

  for (let index = 0; index < pattern.segments.length; index += 1) {
    const segment = pattern.segments[index];
    if (!segment) {
      return null;
    }
    if (segment.kind === "wildcard") {
      return { pattern, params };
    }

    const rawPathSegment = rawSegments[index];
    if (rawPathSegment === undefined) {
      return null;
    }

    if (segment.kind === "literal") {
      if (rawPathSegment !== segment.value) {
        return null;
      }
      continue;
    }

    const decoded = decodePathSegment(rawPathSegment);
    if (decoded === null || decoded.length === 0 || decoded.includes("/")) {
      return null;
    }
    params[segment.name] = decoded;
  }

  return { pattern, params };
}

export function compareRoutePatterns(a: CompiledRoutePattern, b: CompiledRoutePattern): number {
  if (a.literalCount !== b.literalCount) {
    return b.literalCount - a.literalCount;
  }
  if (a.wildcard !== b.wildcard) {
    return a.wildcard ? 1 : -1;
  }
  if (a.segments.length !== b.segments.length) {
    return b.segments.length - a.segments.length;
  }
  return a.pattern.localeCompare(b.pattern);
}

export function findBestRouteMatch<T extends { routePattern: CompiledRoutePattern }>(
  candidates: T[],
  path: string,
): { candidate: T; match: RouteMatch } | null {
  let best: { candidate: T; match: RouteMatch } | null = null;
  for (const candidate of candidates) {
    const match = matchRoutePattern(candidate.routePattern, path);
    if (!match) {
      continue;
    }
    if (!best || compareRoutePatterns(candidate.routePattern, best.candidate.routePattern) < 0) {
      best = { candidate, match };
    }
  }
  return best;
}

export function extractRoutePlaceholders(value: string): string[] {
  const names: string[] = [];
  const regex = /\[([A-Za-z_][A-Za-z0-9_]*)\]/g;
  let match = regex.exec(value);
  while (match) {
    const name = match[1];
    if (name) {
      names.push(name);
    }
    match = regex.exec(value);
  }
  return names;
}

export function interpolateUpstreamUrl(
  upstreamUrl: string,
  params: Record<string, string>,
  incomingOriginalUrl: string,
  excludedQueryParams: ReadonlySet<string> = new Set(),
): URL {
  const target = new URL(upstreamUrl);
  const pathSegments = target.pathname.split("/").map((segment) => {
    const match = PARAM_SEGMENT_REGEX.exec(segment);
    if (!match) {
      return segment;
    }
    const name = match[1];
    if (!name || params[name] === undefined) {
      throw new RouteBuildError("Missing route parameter for upstream URL interpolation", {
        upstreamUrl,
        parameter: name,
      });
    }
    return encodeURIComponent(params[name]);
  });
  target.pathname = pathSegments.join("/");

  const incoming = new URL(incomingOriginalUrl, "http://localhost");
  for (const [key, value] of incoming.searchParams.entries()) {
    if (excludedQueryParams.has(key.toLowerCase())) {
      continue;
    }
    target.searchParams.append(key, value);
  }
  return target;
}
