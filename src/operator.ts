/// <reference types="node" />
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/** A slot server's operator controls: start is always refused, since its matches start only from lobbies; stop stays. */
export interface OperatorControls {
  /** The bearer credential; unset or blank disables the controls. */
  readonly token?: string;
  /** The answer to every start. */
  readonly startRefusal: string;
  running(): boolean;
  stop(): void;
}

/** Header-only, fail-closed operator controls; none, or none with a token, are disabled. Never mounted in MCP or shipped to the viewer. */
export function createOperatorHandler(controls: OperatorControls | undefined) {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const enabled = controls?.token === undefined || controls.token.trim() === "" ? null
    : { controls, expected: digest(`Bearer ${controls.token}`) };
  return (req: IncomingMessage, res: ServerResponse, path: string): void => {
    const reply = (status: number, message: string) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ message }));
    };
    if (path !== "/operator/start" && path !== "/operator/stop") return reply(404, "Not found");
    if (enabled === null) return reply(503, "Operator controls disabled");
    const supplied = req.headers.authorization;
    if (typeof supplied !== "string" || !timingSafeEqual(digest(supplied), enabled.expected)) return reply(401, "Operator credentials required");
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      return reply(405, "Use POST");
    }
    // No cookie auth, query credentials, browser control surface or cross-origin access.
    if (req.headers.origin !== undefined) return reply(403, "Browser requests refused");
    const { controls: slot } = enabled;
    if (path === "/operator/start") return reply(409, slot.startRefusal);
    if (!slot.running()) return reply(409, "No match running");
    slot.stop();
    reply(200, "Match stopped");
  };
}
