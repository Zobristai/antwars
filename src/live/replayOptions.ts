import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseHoldBehaviour } from "../sim/holdBehaviour.js";

/** All simulation-log path readers enter here, before simulation or browser work, and validate
 * the original bytes. The header must name the one hold behaviour every match plays, and so
 * must holds when given; a log without that marker is refused here, as parseLog refuses it. */
export function loadReplayFile(path: string | URL, options: { holds?: string; expectedSha256?: string } = {}): { lines: string[]; sourceSha256: string } {
  if (options.holds !== undefined) parseHoldBehaviour(options.holds);
  const filename = typeof path === "string" ? path : fileURLToPath(path);
  const text = readFileSync(filename, "utf8");
  const sourceSha256 = createHash("sha256").update(text).digest("hex");
  if (options.expectedSha256 !== undefined && sourceSha256 !== options.expectedSha256) {
    throw new Error(`log sha256 ${sourceSha256} is not ${options.expectedSha256}`);
  }
  const lines = text.split("\n");
  const first = lines.findIndex(line => line.trim() !== "");
  if (first < 0) throw new Error("empty match log");
  const parsed: unknown = JSON.parse(lines[first]!);
  if (typeof parsed !== "object" || parsed === null || !("type" in parsed) || parsed.type !== "header") {
    throw new Error("match log must start with its header");
  }
  parseHoldBehaviour((parsed as { holdBehaviour?: unknown }).holdBehaviour);
  return { lines, sourceSha256 };
}
