/// <reference types="node" />
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

interface Controls {
  running(): boolean;
  start(): void;
  stop(): void;
  /** Set on a slot server: start is always refused with this message; stop stays. */
  readonly startRefusal?: string;
}

/** Header-only, fail-closed operator controls. Never mounted in MCP or shipped to the viewer. */
export function createOperatorHandler(token: string | undefined, controls: Controls) {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const expected = token === undefined || token.trim() === "" ? null : digest(`Bearer ${token}`);
  return (req: IncomingMessage, res: ServerResponse, path: string): void => {
    const reply = (status: number, message: string) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ message }));
    };
    if (path !== "/operator/start" && path !== "/operator/stop") return reply(404, "Not found");
    if (expected === null) return reply(503, "Operator controls disabled");
    const supplied = req.headers.authorization;
    if (typeof supplied !== "string" || !timingSafeEqual(digest(supplied), expected)) return reply(401, "Operator credentials required");
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      return reply(405, "Use POST");
    }
    // No cookie auth, query credentials, browser control surface or cross-origin access.
    if (req.headers.origin !== undefined) return reply(403, "Browser requests refused");
    if (path === "/operator/start") {
      if (controls.startRefusal !== undefined) return reply(409, controls.startRefusal);
      if (controls.running()) return reply(409, "A match is already running");
      controls.start();
      return reply(200, "Match started");
    }
    if (!controls.running()) return reply(409, "No match running");
    controls.stop();
    reply(200, "Match stopped");
  };
}
