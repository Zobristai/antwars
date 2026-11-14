// The harness command-line options, shared with the tests.
import type { ParseArgsOptionsConfig } from "node:util";

export const HARNESS_OPTIONS = {
  store: { type: "string" }, commit: { type: "string" }, patch: { type: "string" }, reference: { type: "string" }, "reference-patch": { type: "string" },
  "patch-sha256": { type: "string" }, "reference-patch-sha256": { type: "string" },
  candidate: { type: "string" }, base: { type: "string" }, rounds: { type: "string" }, window: { type: "string" }, scenarios: { type: "string" },
  "seeds-per-map": { type: "string" }, paths: { type: "string" }, checkpoints: { type: "string" }, jobs: { type: "string" }, ticks: { type: "string" },
  session: { type: "string" }, participant: { type: "string" }, expect: { type: "string" }, wait: { type: "string" }, "finish-wait": { type: "string" },
  local: { type: "string" }, whole: { type: "boolean" }, scenario: { type: "string" }, at: { type: "string" }, top: { type: "string" },
} as const satisfies ParseArgsOptionsConfig;
