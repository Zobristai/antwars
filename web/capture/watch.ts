/**
 * Watch a live match on the game server's spectator page: a headless
 * browser keeps the page open on the live stream at the server's configured
 * delay and saves a screenshot at least once a minute, each recorded in
 * shots.json with its stream tick (the page's playback tick), its playback time
 * and the client's frame times. It stops once the page shows the match result,
 * with a last screenshot.
 *
 *   npm run watch -- --url http://127.0.0.1:PORT --logs DIR --out DIR [--every S] [--check] [--timeout-minutes M]
 *
 * --logs is the slot server's data directory. Public discovery selects one lobby
 * and pins the page to it. With --check, use that slot's origin and logs: public
 * proxies deliberately omit the slot-local sequence header. The final tick and
 * winner come from re-simulating the slot log, never from the page.
 *
 * --check proves the page played that match live, revealed no winner before its
 * delayed final tick, and then showed the winning colony. Slots do not schedule
 * a next main match, so there is no next-start-time assertion.
 */
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { COLONY_NAMES } from "../../src/sim/config.ts";
import { asTwoColony } from "../../src/sim/types.ts";
import { replaySteps } from "../../test/tools/summary.ts";
import { loadReplayFile } from "../../src/live/replayOptions.ts";
import { frameOf, openPage, pollResult, type ResultPoll } from "./live-check.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Shot {
  file: string;
  at: string;
  /** The page's playback tick: the stream tick the frame shows. */
  streamTick: number;
  /** The frame's playback time, ms of match time. */
  playbackMs: number;
  /** The client's own frame-time readout (?frametime=1). */
  frameTimes: string;
}

/** The log of match seq in dir, or null. */
function logOf(dir: string, seq: number): string | null {
  const name = readdirSync(dir).find((n) => new RegExp(`^match-.*-${seq}\\.jsonl$`).test(n));
  return name === undefined ? null : join(dir, name);
}

/** The match's final tick and winner, re-simulated from its complete log. */
export function matchEnd(log: string, holds?: string): { finalTick: number; winner: 0 | 1 | null } {
  const { lines } = loadReplayFile(log, { holds });
  const state = replaySteps(lines, "result", () => {});
  if (state.result === null) throw new Error(`${log} does not reach a result`);
  // The stream's final record is the state after the deciding step, as the page's playback tick counts.
  return { finalTick: state.tick, winner: state.result.winner === null ? null : asTwoColony(state.result.winner) };
}

const catalog = z.object({ matches: z.array(z.object({ lobbyId: z.string().uuid() })) });

/** Only public discovery and its exact watch route; never a root game or a join. */
export async function discoverPublicWatch(base: string, request: typeof fetch = fetch): Promise<{ lobbyId: string; seq: number | null }> {
  const response = await request(new URL("/watch/catalog", base), { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`public catalog HTTP ${response.status}`);
  const match = catalog.parse(await response.json()).matches[0];
  if (!match) throw new Error("no live public lobby to watch");
  const head = await request(new URL(`/watch/live/${match.lobbyId}`, base), { signal: AbortSignal.timeout(20_000) });
  await head.body?.cancel();
  if (!head.ok) throw new Error(`public watch HTTP ${head.status}`);
  const header = head.headers.get("x-antwar-match");
  const seq = header === null ? null : Number(header);
  if (seq !== null && (!Number.isSafeInteger(seq) || seq <= 0)) throw new Error("invalid slot-local match sequence");
  return { lobbyId: match.lobbyId, seq };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      url: { type: "string" },
      logs: { type: "string" },
      out: { type: "string" },
      every: { type: "string", default: "60" },
      check: { type: "boolean", default: false },
      holds: { type: "string" },
      "timeout-minutes": { type: "string", default: "45" },
    },
  });
  if (!values.url || !values.logs || !values.out) throw new Error("watch needs --url, --logs and --out");
  const base = values.url.replace(/\/$/, "");
  const logs = resolve(values.logs);
  const out = resolve(values.out);
  const everyMs = Number(values.every) * 1000;
  const timeoutMs = Number(values["timeout-minutes"]) * 60_000;
  mkdirSync(out, { recursive: true });

  const { lobbyId, seq } = await discoverPublicWatch(base);
  console.log(`watching public lobby ${lobbyId} at ${base}/`);
  // A public proxy cannot identify a local log. Refuse before browser work.
  if (values.check) {
    if (seq === null) throw new Error("--check requires the watched slot's origin and local logs, not a public watch proxy");
    const log = logOf(logs, seq);
    if (log === null) throw new Error(`no log for match ${seq} in ${logs}`);
    loadReplayFile(log, { holds: values.holds });
  }

  const p = await openPage(base, 1920, 1080, `?frametime=1&lobby=${encodeURIComponent(lobbyId)}&watch=1`);
  const { page } = p;
  const shots: Shot[] = [];
  const shoot = async (label: string): Promise<Shot> => {
    const f = await frameOf(page);
    const frameTimes = (await page.evaluate(() => window.__antwarCapture.frameTimes()).catch(() => null)) ?? "";
    const file = `${String(shots.length + 1).padStart(3, "0")}-${label}-tick${f.playbackTick}.png`;
    writeFileSync(join(out, file), await page.screenshot({ type: "png" }));
    const shot = { file, at: new Date().toISOString(), streamTick: f.playbackTick, playbackMs: Math.round(f.playbackMs), frameTimes };
    shots.push(shot);
    writeFileSync(join(out, "shots.json"), `${JSON.stringify({ url: `${base}/`, lobbyId, match: seq, rendererString: p.info.rendererString, everySeconds: everyMs / 1000, shots }, null, 1)}\n`);
    console.log(`${shot.at} ${file} frame times: ${frameTimes || "n/a"}`);
    return shot;
  };

  let polls: ResultPoll[] = [];
  try {
    let done = false;
    const shooter = (async () => {
      let next = Date.now();
      while (!done) {
        if (Date.now() >= next) {
          await shoot("live");
          next += everyMs;
        }
        await sleep(250);
      }
    })();
    try {
      polls = await pollResult(page, () => null, timeoutMs);
    } finally {
      done = true;
      await shooter;
    }
    await shoot("result");

    if (!values.check || seq === null) return;
    // Judge against the server's own record: the complete log of the watched match.
    const log = logOf(logs, seq);
    if (log === null) throw new Error(`no log for match ${seq} in ${logs}`);
    const { finalTick, winner } = matchEnd(log, values.holds);
    const live = shots.filter((s) => s.file.includes("-live-"));
    const last = polls.at(-1)!;
    const early = polls.filter((x) => x.tick < finalTick && (x.shown || x.wins));
    const results = [
      {
        name: "the page shows the scheduled match live: its playback tick advances between screenshots before the result",
        pass: live.length >= 2 && live.at(-1)!.streamTick > live[0]!.streamTick,
        detail: live.map((s) => s.streamTick),
      },
      {
        name: "no page element shows the winner before delayed playback reaches the final tick",
        pass: early.length === 0 && last.tick === finalTick,
        detail: { finalTick, polls: polls.length, early: early.length, shownAt: last.tick },
      },
      {
        name: "the page shows the slot match's winning colony or draw",
        pass: winner === null ? /draw/i.test(last.text) : last.text.includes(COLONY_NAMES[winner]),
        detail: { winner: winner === null ? "draw" : COLONY_NAMES[winner], text: last.text },
      },
    ];
    for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}  ${JSON.stringify(r.detail).slice(0, 400)}`);
    writeFileSync(join(out, "check.json"), `${JSON.stringify({ url: `${base}/`, lobbyId, match: seq, log, results }, null, 1)}\n`);
    if (results.some((r) => !r.pass)) process.exitCode = 1;
  } finally {
    await p.close();
  }
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
