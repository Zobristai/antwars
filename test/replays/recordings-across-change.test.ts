import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { playScripted, recordLog } from "../../src/live/record.ts";
import { PUBLIC_CONFIG, rulesConfig } from "../../src/sim/config.ts";
import { newMatchConfig } from "../../src/sim/gridScale.ts";
import { replay, stateHash } from "../../src/sim/log.ts";
import { playable } from "../playable.ts";

/**
 * Match logs recorded before the economy cleanup still re-simulate and re-record as recorded.
 *
 * fixtures/scripted-public.jsonl and fixtures/scripted-redesign.jsonl are the match logs of
 * playScripted({ seed: 6006, agents: 4, ticks: 900, attack: true }) on the public and new-match redesign configs,
 * written on main 810fe97148ef600b5b7c802bae3fdee4a8ee5b80. fixtures/scripted-hashes.json holds that commit's
 * stateHash after every one of the 900 ticks (replay) and the SHA256 of recordLog's concatenated stream frames.
 */
const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);
const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const TICKS = 900;
const RECORDED = JSON.parse(readFileSync(fixture("scripted-hashes.json"), "utf8")) as
  Record<"public" | "redesign", { ticks: number; hashes: string[]; frames: number; framesSha256: string }>;
const CONFIGS = { public: playable(PUBLIC_CONFIG), redesign: newMatchConfig(rulesConfig("redesign")) } as const;

describe.each(["public", "redesign"] as const)("a %s match log recorded before the change", name => {
  const text = readFileSync(fixture(`scripted-${name}.jsonl`), "utf8");
  const lines = text.split("\n").filter(line => line !== "");
  const recorded = RECORDED[name];

  it("re-simulates to the recorded hash after every tick", () => {
    const hashes: string[] = [];
    replay(lines, TICKS, state => { hashes.push(stateHash(state)); });
    expect(recorded.ticks).toBe(TICKS);
    expect(hashes).toEqual(recorded.hashes);
  }, 60_000);

  it("re-records the recorded stream frames byte for byte", () => {
    const frames = recordLog(lines, TICKS);
    expect(frames).toHaveLength(recorded.frames);
    expect(sha256(Buffer.concat(frames.map(frame => Buffer.from(frame))))).toBe(recorded.framesSha256);
  }, 60_000);

  it("is the log the same match writes today, header included", () => {
    const { lines: today } = playScripted({ seed: 6006, config: CONFIGS[name], agents: 4, ticks: TICKS, attack: true });
    expect(`${today.join("\n")}\n`).toBe(text);
  }, 60_000);
});
