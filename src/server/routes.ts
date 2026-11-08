/// <reference types="node" />
import type { IncomingMessage, ServerResponse } from "node:http";

/** Serves one request on a route; path is the request's pathname. */
export type RouteHandler = (req: IncomingMessage, res: ServerResponse, path: string) => void | Promise<void>;

/**
 * One fixed route of a server: an exact path, every path under a prefix
 * (which ends in "/"), or a pattern that answers the handler for the paths it takes and null
 * for the rest, so those fall through to the mounts. routeClass names the route in 500 logs,
 * never the URL.
 */
export type Route =
  | { readonly routeClass: string; readonly path: string; readonly handle: RouteHandler }
  | { readonly routeClass: string; readonly under: string; readonly handle: RouteHandler }
  | { readonly routeClass: string; readonly match: (path: string) => RouteHandler | null };

export interface ResolvedRoute {
  readonly routeClass: string;
  readonly handle: RouteHandler;
}

export interface RouteTable {
  /** The route that takes path, or null when none does. */
  resolve(path: string): ResolvedRoute | null;
}

/**
 * The fixed routes as one table in place of an ordered dispatch chain: the routes a server
 * composes take disjoint paths, so their order does not decide a request. Exact paths are
 * looked up first; a second route for the same exact path is refused.
 */
export function routeTable(routes: readonly Route[]): RouteTable {
  const exact = new Map<string, ResolvedRoute>();
  const rest: Exclude<Route, { path: string }>[] = [];
  for (const route of routes) {
    if ("path" in route) {
      if (exact.has(route.path)) throw new Error(`two routes for ${route.path}`);
      exact.set(route.path, { routeClass: route.routeClass, handle: route.handle });
    } else {
      rest.push(route);
    }
  }
  return {
    resolve(path) {
      const found = exact.get(path);
      if (found !== undefined) return found;
      for (const route of rest) {
        if ("under" in route) {
          if (path.startsWith(route.under)) return { routeClass: route.routeClass, handle: route.handle };
          continue;
        }
        const handle = route.match(path);
        if (handle !== null) return { routeClass: route.routeClass, handle };
      }
      return null;
    },
  };
}
