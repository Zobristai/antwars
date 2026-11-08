// Essential suite: every test except the slow, full-only files below.
// `npm run test:essential` runs this config on every merge;
// `npm run test:full` runs vitest.config.ts (every test) before deploys.
// This list is the one place that decides what is full-only; CI checks it
// against the discovered files (scripts/ci/test-set-diff.ts).
import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.ts";

export const FULL_ONLY: readonly string[] = [
  // Map acceptance sweeps
  "test/sim/map-twin-shields.test.ts",
  "test/sim/map-wide-plain.test.ts",
  "test/sim/map-isthmus.test.ts",
  "test/sim/map-four-lanes.test.ts",
  // Deploy tooling (fake-gcloud process runs)
  "deploy/cloud-run/deploy.test.ts",
  "deploy/cloud-run/domain.test.ts",
  // Spectator presentation measurements
  "test/spectator/motion.test.ts",
  "test/spectator/pivot.test.ts",
  "test/spectator/queen-hp.test.ts",
  "test/spectator/bite.test.ts",
  "test/spectator/bite-facing.test.ts",
  "test/spectator/replay-seek.test.ts",
  // MCP reply-size sweeps
  "test/mcp/response-size.test.ts",
  "test/mcp/slot-response-size.test.ts",
  "test/mcp/finer-grid-slot-replies.test.ts",
  // Long simulations and capacity checks
  "test/sim/guard-settling-match.test.ts",
  "test/sim/lineup.test.ts",
  "test/sim/forager-rest-pass.test.ts",
  "test/sim/fighter-water-rally.test.ts",
  "test/sim/seated-worker-guard-settling.test.ts",
  "test/sim/soldier-spacing.test.ts",
  "test/sim/colonyScale.test.ts",
  "test/sim/point-capacity-organic-cluster-central-lake.test.ts",
  "test/sim/point-capacity-organic-cluster-open-field.test.ts",
  "test/sim/point-capacity-organic-cluster-three-crossings.test.ts",
  "test/tuning/checkpoint.test.ts",
  // Live process and browser-fixture runs
  "test/live/bandwidth.test.ts",
  "test/live/spectator-world.test.ts",
  "test/slots/two-processes.test.ts",
  // Long handover replays (35,000-tick history match)
  "test/slots/handover-wide-plain.test.ts",
  // Balance sweep process runs
  "test/tools/balance-activity.test.ts",
];

export default mergeConfig(
  base,
  defineConfig({
    test: {
      exclude: [...configDefaults.exclude, ...FULL_ONLY],
      // CI sets ANTWAR_COVERAGE=1 for a coverage summary; other runs are unchanged.
      coverage: {
        enabled: process.env.ANTWAR_COVERAGE === "1",
        provider: "v8",
        reporter: ["text-summary"],
      },
    },
  }),
);
