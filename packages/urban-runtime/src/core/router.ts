// A minimal path router shared by the surfaces and triggers modules so the runtime serves
// a single HTTP port. Matching is exact path or, for a route registered with `prefix`,
// a path-prefix match. First match wins.

import type { HttpHandler, HttpRequest, HttpResponse } from "./host.ts";

export interface Route {
  method: string;
  path: string;
  /** When true, match any path that starts with `path`. */
  prefix?: boolean;
  handler: HttpHandler;
  /** For diagnostics / inspect(). */
  source?: string;
}

export function json(body: unknown, status = 200): HttpResponse {
  return { status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

export function html(body: string, status = 200): HttpResponse {
  return { status, headers: { "content-type": "text/html; charset=utf-8" }, body };
}

export function text(body: string, status = 200): HttpResponse {
  return { status, headers: { "content-type": "text/plain; charset=utf-8" }, body };
}

function matches(route: Route, req: HttpRequest): boolean {
  if (route.method !== "*" && route.method.toUpperCase() !== req.method.toUpperCase()) return false;
  return route.prefix ? req.path.startsWith(route.path) : req.path === route.path;
}

/** Build a single HttpHandler that dispatches across the given routes. */
export function makeRouter(routes: Route[]): HttpHandler {
  return async (req: HttpRequest): Promise<HttpResponse> => {
    for (const route of routes) {
      if (matches(route, req)) return route.handler(req);
    }
    return text("not found", 404);
  };
}
