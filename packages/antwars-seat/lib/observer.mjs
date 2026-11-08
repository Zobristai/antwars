// Background observer: one observe call every interval. One idle rule applies
// to every match: any accepted call, observe included, resets the seat's idle
// clock (300 s default; live value houseIdleSeconds). An idle seat abandons a
// Model Index (house-*) match and loses any other match for its colony; both
// colonies idle on the same tick is a draw. So this keeps the seat in the
// match. It also keeps the MCP session alive and never sends commands for the
// seat. A failed observe is retried sooner. It re-joins through the match client when the
// session is gone, and stops on matchOver or when the stop file appears.
import { existsSync, rmSync } from "node:fs";
import { errorCode } from "./mcp.mjs";
import { isMatchOver, matchClient, savedMatch } from "./match.mjs";
import { envNumber, progress, readJson, statePath, writeJson } from "./state.mjs";

export const DEFAULT_INTERVAL_S = 60;
export const DEFAULT_RETRY_S = 10;

export function observerSettings(env, flags = {}) {
  const intervalS = Number(flags.interval ?? envNumber(env, "ANTWARS_OBSERVER_INTERVAL_S", DEFAULT_INTERVAL_S));
  const retryS = Number(flags.retry ?? envNumber(env, "ANTWARS_OBSERVER_RETRY_S", DEFAULT_RETRY_S));
  if (!(intervalS > 0 && intervalS <= 240)) throw new Error("observer interval must be in (0, 240] seconds to stay inside the idle limit (300 s default)");
  if (!(retryS > 0)) throw new Error("observer retry must be positive");
  return { intervalMs: intervalS * 1000, retryMs: Math.min(retryS, intervalS) * 1000 };
}

export async function runObserver(ctx, { intervalMs, retryMs }) {
  const { env, clock } = ctx;
  const file = statePath("observer.json", env);
  const stopFile = statePath("observer.stop", env);
  const match = savedMatch(env);
  const client = matchClient(ctx, match.mcpUrl);
  const status = { pid: process.pid, state: "running", startedAt: new Date(clock.now()).toISOString(), intervalMs, retryMs,
    calls: 0, failures: 0, lastOkAt: null, lastError: null, lobbyId: match.lobbyId };
  writeJson(file, status);
  for (;;) {
    if (existsSync(stopFile)) {
      rmSync(stopFile, { force: true });
      Object.assign(status, { state: "stopped", stoppedAt: new Date(clock.now()).toISOString() });
      writeJson(file, status);
      progress("observer_stopped", {}, env);
      return status;
    }
    let ok = false;
    try {
      const reply = await client.callTool("observe", {});
      status.calls += 1;
      if (isMatchOver(reply.data)) {
        Object.assign(status, { state: "match_over", stoppedAt: new Date(clock.now()).toISOString(),
          winner: reply.data.winner ?? null, lastOkAt: new Date(clock.now()).toISOString() });
        writeJson(file, status);
        progress("observer_match_over", { winner: reply.data.winner ?? null }, env);
        return status;
      }
      ok = reply.ok;
      if (ok) Object.assign(status, { lastOkAt: new Date(clock.now()).toISOString(), lastError: null, tick: reply.data.view?.tick ?? null });
      else Object.assign(status, { failures: status.failures + 1, lastError: errorCode(reply.data) });
    } catch (error) {
      Object.assign(status, { failures: status.failures + 1, lastError: error instanceof Error ? error.message : String(error) });
    }
    writeJson(file, status);
    // Sleep in short steps so `observer stop` takes effect within a second.
    for (let left = ok ? intervalMs : retryMs; left > 0 && !existsSync(stopFile); left -= 1000) await clock.sleep(Math.min(1000, left));
  }
}

export function observerStatus(env, isAlive) {
  const status = readJson(statePath("observer.json", env));
  if (status === null) return { state: "not_started" };
  if (status.state === "running" && !isAlive(status.pid)) return { ...status, state: "dead" };
  return status;
}
