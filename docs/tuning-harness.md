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
The store holds data only: it is read, never imported or run.

**Trust.** The harness trusts processes running as its own operating-system user, and treats every other writer to
the store as untrusted. So:

- Every store write goes to a fresh file created in the target directory and is then renamed over the final name.
  Readers never see a partial file, and a write replaces a link at that name rather than writing through it.
- Every store read refuses a symbolic link, at the file or at any directory between the store root and it.
- Worker processes read and write only private files; the harness copies data into and out of the store.
- `exact` always plays the candidate. It reads only the reference from the store, and only after checking it against
  the digest `regen` printed.

| Store path | Contents |
| --- | --- |
| `workloads/<commit>.json` | The workload `regen` generated at that commit. |
| `references/<commit>/<horizon>/<path>/<scenario>.json` | Per-tick exactness digests that `regen` wrote at that commit. |
| `checkpoints/<commit>/<scenario>/<tick>.json` | Saved match states, written when `regen` is given `--checkpoints`. |
| `noise/<session>/` | Noise-check arrivals, the admitted list, readiness and each participant's results. |
| `runs/`, `profiles/` | Every report, and every CPU profile. |

Commits are any commit-ish of this checkout. `--patch <file> --patch-sha256 <hex>` applies a patch to the candidate's
tree, and, for `time`, `--reference-patch <file> --reference-patch-sha256 <hex>` applies one to the reference's tree.
A patch is applied only when its SHA-256 equals the digest given; otherwise the command stops.

## Candidate trees

Each command extracts every commit it runs from git objects into a private temporary directory of its own, readable
only by its user, applies any patch there, runs from there and removes it when it exits. Trees are never kept in or
run from the store.

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

### `regen --commit <c> [--seeds-per-map 2] [--paths advance,step] [--checkpoints 4] [--jobs <n>] [--scenarios …] [--ticks <n>]`

Writes the workload and the exactness references at commit `c`, playing everything afresh; nothing already in the
store is reused. Runs that do not depend on each other go in parallel, `--jobs` at a time. Run `regen` at the base
commit before `exact`, `time`, `noise` or `profile` use that base.

It also saves each scenario's state at `--checkpoints` evenly spaced ticks of its full match: by default 4, at 0, ¼,
½ and ¾. `time`, `noise` and `profile --at` start from these saved states. `--checkpoints 0` saves none. The
workload lists only saved states that exist, since a match can end before a late one.

It prints `referenceSha256`: the SHA-256 of the workload file and every reference written. Keep it; `exact` needs
it. `--scenarios` and `--ticks` make a short workload, for smoke runs.

### `exact --reference <c> --reference-sha256 <hex> --candidate <c> [--patch <file> --patch-sha256 <hex>] [--paths …] [--scenarios …] [--ticks <n>]`

Checks the references `regen` wrote at `c` against `--reference-sha256` and stops if they differ. It then plays every
scenario on the candidate, always afresh, and compares four streams on every tick, on each tick path:

- the full state
- the events
- the input results
- the recorded and sent spectator message bytes

The tick paths are `advance` (the live server's) and `step` (replay verification's). Each stream is a chained
SHA-256 over its raw bytes, and **no normalisation is applied**.

The report gives the reference digest it checked against, the horizon, the seeds and the paths. For each scenario it gives a match, or the first tick and
streams that differ. The command exits 1 on any difference.

### `time --reference <c> --candidate <c> [--patch <file> --patch-sha256 <hex>] [--rounds 8] [--window 200 | --whole] [--scenarios …]`

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

By default each segment is 200 ticks from one saved state, weighted by its map's share of the rotation divided among
its seeds and saved states, so a try covers the start, middle and late game of every map. `--window n` sets the ticks;
`--whole` times whole matches instead. Segments from saved states inside a point-rest stretch stay in, because live
matches reach them. The report lists every segment whose reference had ticks over 500 ms (`slowSegments`) and
gives each segment's figures (`perSegment`, keyed `<scenario>@<tick>`).

### `noise --base <c> --session <name> --participant <id> --expect <n> [--wait 600] [--rounds 8] [--window 200 | --whole]`

Every participant times the unchanged base against itself in the same paired rounds as `time`, while the others run
at the same time:

- **Admission:** participants meet in the store. Admission closes when `--expect` participants have arrived or
  `--wait` seconds have passed. Anyone arriving later is refused.
- **Repeats:** when fewer than three participants are admitted, each one repeats the check until at least three
  medians exist.
- **Ready:** once admitted, each participant prepares its tree and waits until every admitted participant is ready,
  so all measurements start together.
- **Finish:** a participant that finishes keeps running the same load until every admitted participant has finished,
  so every measurement runs under the whole concurrent load. The waits are capped by `--finish-wait`, in seconds.
- **Files:** arrivals, the admitted list, readiness and results are each written whole under a temporary name and then
  moved into place, so no participant reads a partial file.
- **Report:**
  - the admitted participants and how long admission took
  - each participant's median paired gain
  - their range
  - the **noise bar**, the largest absolute median
  - the configuration loaded
  - how long it held the load after finishing

A candidate's median paired gain must exceed the noise bar to count. `--local <n>` starts `n` participants on this
host and prints the first one's report.

### `profile --commit <c> [--patch <file> --patch-sha256 <hex>] [--scenario <id>] [--ticks <n>] [--at <tick>] [--top 30]`

CPU-profiles the ticks only, not start-up, and reports each function's self and inclusive time. Inclusive time
counts each function once per sample, even under recursion. The default scenario is the first Wide Plain one. The
report includes the configuration loaded and the saved `.cpuprofile`.

### `test --commit <c> [--patch <file> --patch-sha256 <hex>]`

Runs the scoped simulator tests in that tree. These are the simulation goldens, the advance/step agreement, the
grid, combat and every replay and recording test, listed in `SCOPED_TESTS` in `scripts/tuning/harness.ts`.
