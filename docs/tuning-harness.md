# Simulator tuning harness

`scripts/tuning/harness.ts` measures simulator speed and proves a change computes exactly what its base computes.
A performance-tuning run uses it to try many small changes and keep only the ones that are faster and exact.
It is separate from the older lane loop in `test/tuning/`, which is unchanged.

Run every command from the repository root, after `npm ci`:

```sh
npm run tune -- <command> [options]
```

## The shared store

Every command reads and writes one directory, the store. Give it with `--store <dir>` or the `ANTWARS_TUNING_STORE`
environment variable. Every participant in a run must use the same store. Nothing is written inside the checkout.

| Store path | Contents |
| --- | --- |
| `trees/<key>/` | A commit, or a commit plus a patch, extracted from git objects. The key is the full SHA, plus `-` and the first 16 hex characters of the patch's SHA-256. |
| `workloads/<commit>.json` | The workload `regen` generated at that commit. |
| `references/<key>/…` | Per-tick exactness digests for each scenario and tick path. |
| `checkpoints/<commit>/<scenario>/<tick>.json` | Saved match states, written when `regen` is given `--checkpoints`. |
| `noise/<session>/` | Noise-check arrivals, the admitted list and each participant's results. |
| `runs/`, `profiles/` | Every report, and every CPU profile. |

Commits are any commit-ish of this checkout. `--patch <file>` applies a patch to the candidate's tree, and
`--reference-patch <file>` applies one to the reference's tree.

## Workload

The harness plays what the game server plays for an ordinary scheduled match. Each worker process loads the timed
tree's own code:

- **Config:** `comparisonOptions` in `src/server.ts` with no comparison variables set. Today that is the redesign
  rules with the no-bot-moves flag on.
- **Match start:** `createMatch(seed, config)`.
- **Each tick:** `advance(state, [], …, houseActive = true)`, as `Game.tick` does.

No agent is seated and no input is sent, so every colony's free ants play on their own rules from the starting
population.

- **Maps:** every map in the live rotation.
- **Seeds:** the first `--seeds-per-map` seeds (default 2) that draw each map.
- **Weights:** each scenario counts for its map's share of the rotation, divided among that map's seeds.
- **Horizon:** each match plays until it ends by its own match-end rule: its map's match length, or an earlier
  result.

`--ticks <n>` stops every run after `n` ticks instead. This is for smoke runs, and every report states it.

Every timing and profile report includes `loaded`: the configuration the process actually loaded. That is the rules,
the no-bot-moves flag, the map, the seed, the colonies, any seated agents, the starting population and cap, the match
length and the Node version.

## Commands

### `regen --commit <c> [--seeds-per-map 2] [--paths advance,step] [--checkpoints <k>] [--jobs <n>]`

Writes the workload and the exactness references at commit `c`. Runs that do not depend on each other go in
parallel, `--jobs` at a time. Run `regen` at the base commit before `exact`, `time`, `noise` or `profile` use that
base.

With `--checkpoints k`, it also saves each scenario's state at `k` evenly spaced ticks. `time --window` and
`profile --at` start from these saved states.

### `exact --reference <c> --candidate <c> [--patch <file>] [--paths …] [--scenarios …]`

Plays every scenario on both trees and compares four streams on every tick, on each tick path:

- the full state
- the events
- the input results
- the recorded and sent spectator message bytes

The tick paths are `advance` (the live server's) and `step` (replay verification's). Each stream is a chained
SHA-256 over its raw bytes, and **no normalisation is applied**.

The report gives the horizon, the seeds and the paths. For each scenario it gives a match, or the first tick and
streams that differ. The command exits 1 on any difference.

### `time --reference <c> --candidate <c> [--patch <file>] [--rounds 8] [--window <n>] [--scenarios …]`

Interleaved, paired side-by-side timing on one host:

- **Rounds:** each round runs every workload segment once per side. Each side's round is one fresh process with the
  Node heap flags of `npm start`, timing the segments in the same order. The side that runs first alternates by round.
- **Round gain:** `1 − (weighted candidate mean tick time) / (weighted reference mean tick time)`. Positive means
  the candidate is faster.
- **Report:**
  - the round count
  - every round's gain
  - the **median paired gain**
  - each side's mean, median, p99 and max tick time and GC time, per scenario
  - the host's load before and after

`--window n` times `n` ticks from each saved checkpoint instead of whole matches.

### `noise --base <c> --session <name> --participant <id> --expect <n> [--wait 600] [--rounds 8] [--window <n>]`

Every participant times the unchanged base against itself in the same paired rounds as `time`, while the others run
at the same time:

- **Admission:** participants meet in the store. Admission closes when `--expect` participants have arrived or
  `--wait` seconds have passed. Anyone arriving later is refused.
- **Repeats:** when fewer than three participants are admitted, each one repeats the check until at least three
  medians exist.
- **Finish:** each participant waits for every admitted participant to finish. The wait is capped by
  `--finish-wait`, in seconds.
- **Report:**
  - the admitted participants and how long admission took
  - each participant's median paired gain
  - their range
  - the **noise bar**, the largest absolute median
  - the configuration loaded

A candidate's median paired gain must exceed the noise bar to count. `--local <n>` starts `n` participants on this
host and prints the first one's report.

### `profile --commit <c> [--patch <file>] [--scenario <id>] [--ticks <n>] [--at <tick>] [--top 30]`

CPU-profiles the ticks only, not start-up, and reports each function's self and inclusive time. Inclusive time
counts each function once per sample, even under recursion. The default scenario is the first Wide Plain one. The
report includes the configuration loaded and the saved `.cpuprofile`.

### `test --commit <c> [--patch <file>]`

Runs the scoped simulator tests in that tree. These are the simulation goldens, the advance/step agreement, the
grid, combat and every replay and recording test, listed in `SCOPED_TESTS` in `scripts/tuning/harness.ts`.
