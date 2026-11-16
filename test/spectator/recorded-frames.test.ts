/**
 * Recordings made before flyers existed play back to the same frames as before flyers were drawn.
 *
 * Each committed stream recording is decoded with decodeMessage and played through Playback twice:
 * on the recording route (Playback() with push, as a recording page plays it) and on the live route
 * (Playback({ live: true }) fed by a worker-side TickPreparation, as a live page plays it). One reused
 * Frame is sampled every 25 ms, so the recording route samples every message's tick and three points
 * between ticks, and the live route samples its buffering, its start, its waiting and its catch-up.
 *
 * Every field a Frame had before flyers were drawn is digested at every sample, in the groups below.
 * The pinned digests were generated from the program branch before any flyer drawing landed; they are
 * never regenerated from a later tip. A mismatch means playback of an existing recording changed.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodeMessage, type StreamMessage } from "../../src/live/format.ts";
import { TICK_MS, unpackMessages } from "../../src/live/snapshot.ts";
import { Frame, Playback, RENDER_DELAY_MS, TickPreparation, type Board } from "../../web/src/buffer.ts";
import { LIVE_BUFFER_MS } from "../../web/src/playout.ts";

const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Every committed stream recording: the rules-27 call recording first, then the repository's others. */
const RECORDINGS = [
  { name: "calls-rules27", path: "../live/fixtures/calls-rules27-06c6e13f.bin", sha: "e03d69236e8297cd4a281296dd4985fb002a4c2c6ac344dc33ca330dec566d6d" },
  { name: "calls-rules26", path: "../live/fixtures/calls-rules26-06c6e13f.bin", sha: "2e0386c2aef2c716ef66e722de25e29e2ba1168f83c9ca56f0f71328d868bc35" },
  { name: "rated-identity", path: "../live/fixtures/rated-identity-6e6b73b9.bin", sha: "22de4266da2000850dd93eeec6ded85c5f408b110b5dcc094aba67b0f36e8368" },
  { name: "pre-compression", path: "../replays/fixtures/pre-compression-replay.bin", sha: "ef2eb8d4c609b3b65c0eaec9f5f3f2e860cd9025046db28b403795606d9e7bcd" },
  { name: "queen-framing-3d", path: "../../web/capture/fixtures/queen-framing-3d.bin", sha: "ef3dd104456106c2677c98fa8c26633a2e558cc3bdec9dfeb03e8126579ff753" },
] as const;

type Route = "recording" | "live";
const ROUTES: readonly Route[] = ["recording", "live"];
const SAMPLE_STEP_MS = 25;

/** The Board fields as they were before flyers were drawn. */
const BOARD_FIELDS = ["setup", "territoryWin", "queens", "territory", "held", "marks", "agents", "overrun",
  "overrunRequired", "deaths", "hatched", "result", "food", "hatch", "stores"] as const satisfies readonly (keyof Board)[];
/** The stream ant fields as they were before flyers were drawn. */
const ANT_FIELDS = ["count", "id", "x", "y", "heading", "colony", "agent", "caste", "carrying"] as const;

/**
 * Every Frame field as it was before flyers were drawn, grouped so a mismatch names what changed.
 * Per-ant arrays are read over the frame's ants only, never its spare capacity.
 */
const GROUPS = {
  clock: (f, drew) => [drew, f.renderMs, f.targetMs, f.tick, f.blend, f.match].map(canon),
  ants: (f) => [f.count, perAnt(f, f.id), perAnt(f, f.colony), perAnt(f, f.agent)].map(canon).concat(streamAnts(f)),
  positions: (f) => [perAnt(f, f.x), perAnt(f, f.y), perAnt(f, f.drawX), perAnt(f, f.drawY)].map(canon),
  facings: (f) => [perAnt(f, f.rotation), perAnt(f, f.drawRotation)].map(canon),
  castes: (f) => [canon(perAnt(f, f.caste))],
  carrying: (f) => [canon(perAnt(f, f.carrying))],
  alphas: (f) => [canon(perAnt(f, f.alpha))],
  walk: (f) => [canon(perAnt(f, f.walk))],
  corpses: (f) => [canon(f.corpses)],
  fights: (f) => [canon(f.fights), canon(f.engagements)],
  marks: (f) => [canon(f.marks)],
  hits: (f) => [canon(f.hits)],
  board: (f) => [canon(f.mapW), canon(f.mapH), board(f), held(f.territoryA), held(f.territoryB), held(f.trails),
    canon(f.fog), canon(f.lossShown), canon(f.endShown)],
  story: (f) => [canon(f.story), canon(f.chat), canon(f.commands)],
} satisfies Record<string, (f: Frame, drew: boolean) => string[]>;
type Group = keyof typeof GROUPS;

function perAnt(f: Frame, values: { subarray(start: number, end: number): unknown } | null): unknown {
  return values === null ? null : values.subarray(0, f.count);
}

/**
 * A canonical text of a value: numbers exactly (keeping -0), typed arrays by type, length and the
 * digest of their bytes, maps in their order, objects by sorted key with undefined members left out.
 */
function canon(v: unknown): string {
  if (v === undefined) return "u";
  if (v === null) return "n";
  if (typeof v === "number") return Object.is(v, -0) ? "-0" : String(v);
  if (typeof v === "boolean") return v ? "t" : "f";
  if (typeof v === "string") return JSON.stringify(v);
  if (ArrayBuffer.isView(v)) {
    const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    return `${v.constructor.name}(${(v as unknown as ArrayLike<number>).length}:${sha256(bytes)})`;
  }
  if (v instanceof Map) return `Map{${[...v].map(([k, x]) => `${canon(k)}=>${canon(x)}`).join(",")}}`;
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(",")}}`;
}

/** Held boards, their parts, trails and stream ants never change once pushed, so their text is computed once. */
const texts = new WeakMap<object, string>();
function held(v: object | null, text: (v: object) => string = canon): string {
  if (v === null) return "n";
  let t = texts.get(v);
  if (t === undefined) texts.set(v, t = text(v));
  return t;
}
function board(f: Frame): string {
  return held(f.board, (b) => `{${BOARD_FIELDS.flatMap((k) => {
    const x = (b as Board)[k];
    return x === undefined ? [] : [`${k}:${typeof x === "object" && x !== null ? held(x) : canon(x)}`];
  }).join(",")}}`);
}
function streamAnts(f: Frame): string {
  return held(f.ants, (a) => `{${ANT_FIELDS.flatMap((k) => {
    const x = (a as Record<string, unknown>)[k];
    return x === undefined ? [] : [`${k}:${canon(x)}`];
  }).join(",")}}`);
}

function load(path: string): { sha: string; messages: StreamMessage[] } {
  const file = new Uint8Array(readFileSync(new URL(path, import.meta.url)));
  const bytes = file[0] === 0x1f && file[1] === 0x8b ? new Uint8Array(gunzipSync(file)) : file;
  return { sha: sha256(file), messages: unpackMessages(bytes).map((m) => decodeMessage(m)) };
}

interface Played {
  samples: number;
  drawn: number;
  frames: string;
  groups: Record<Group, string>;
}

/**
 * Feed a recording on one route and digest every 25 ms sample of one reused Frame. A recording arrives at
 * its tick times; the live stream arrives at half that pace, as over a slow connection, so the live buffer
 * starts within every recording, one ending on a reconnect snapshot included, and its waiting and
 * catch-up are sampled too.
 */
function play(messages: readonly StreamMessage[], route: Route): Played {
  const first = messages[0]!.tick;
  const msPerTick = route === "live" ? 2 * TICK_MS : TICK_MS;
  const arrivals = messages.map((m) => ({ m, at: (m.tick - first) * msPerTick }));
  const endMs = 2 * arrivals.at(-1)!.at + LIVE_BUFFER_MS + RENDER_DELAY_MS + 1000;
  const playback = route === "live" ? new Playback({ live: true }) : new Playback();
  const worker = new TickPreparation();
  const frame = new Frame();
  const frames = createHash("sha256");
  const groups = Object.fromEntries(Object.keys(GROUPS).map((g) => [g, createHash("sha256")])) as Record<Group, ReturnType<typeof createHash>>;
  let next = 0, samples = 0, drawn = 0;
  for (let now = 0; now <= endMs; now += SAMPLE_STEP_MS) {
    for (; next < arrivals.length && arrivals[next]!.at <= now; next++) {
      const { m, at } = arrivals[next]!;
      if (route === "recording") playback.push(m, at);
      else {
        const prepared = worker.prepare(m);
        if (prepared) playback.pushPrepared(structuredClone(prepared), at);
      }
    }
    const drew = playback.sample(now, frame);
    if (drew) drawn++;
    for (const [group, read] of Object.entries(GROUPS) as [Group, (f: Frame, drew: boolean) => string[]][]) {
      const text = `${samples}|${read(frame, drew).join("|")}`;
      groups[group].update(`${text}\n`);
      frames.update(`${group}:${text}\n`);
    }
    samples++;
  }
  return {
    samples, drawn, frames: frames.digest("hex"),
    groups: Object.fromEntries(Object.entries(groups).map(([g, h]) => [g, h.digest("hex")])) as Record<Group, string>,
  };
}

const played = new Map<string, Played>();
function playedOf(name: (typeof RECORDINGS)[number]["name"], route: Route): Played {
  const key = `${name}/${route}`;
  let p = played.get(key);
  if (p === undefined) played.set(key, p = play(load(RECORDINGS.find((r) => r.name === name)!.path).messages, route));
  return p;
}

/** Each recording and route: samples taken, samples drawn and the digest of every sampled frame. */
const PINNED_FRAMES: Record<string, Omit<Played, "groups">> = {
  "calls-rules27/recording": { samples: 175, drawn: 175, frames: "cb6d0b8b6b68f31062ea961bfb888add1226cda4a5157987910943ee4acbdcb2" },
  "calls-rules27/live": { samples: 239, drawn: 179, frames: "d77fed02aa58cd60951ae871d22a4950a1e226e7ef7aaa096d528ef698cf1143" },
  "calls-rules26/recording": { samples: 175, drawn: 175, frames: "aa8a0d8f6f7d000d9ef1158d641588355e37389592c8208417013f0abeed8b69" },
  "calls-rules26/live": { samples: 239, drawn: 179, frames: "2628d0d8ee9ffc2e67de22bbe363c05ee628eb6aa16091feaffbdf4029151ccc" },
  "rated-identity/recording": { samples: 207, drawn: 207, frames: "6e4dbb47d3958cccbbe9bd4c1772d4f6ce32fc0de0657f61b66bd3664481e09d" },
  "rated-identity/live": { samples: 303, drawn: 36, frames: "e84ce861f7c41816c87754c3d1f0135da9da4da099f01dd50572bc196a64896b" },
  "pre-compression/recording": { samples: 143, drawn: 143, frames: "ce342f3e65c565799fa611ade5ca851b3b6d1daabf002912483776dbe2653a14" },
  "pre-compression/live": { samples: 175, drawn: 115, frames: "0f7e49c770a2a412a90d49243e8ac9c77140821fc2a88e3c492bfd91be1785c7" },
  "queen-framing-3d/recording": { samples: 119, drawn: 119, frames: "0532a7e46c711348af2717edd4e8b0d1e2dd35d7a0debc967722877cdda3fc92" },
  "queen-framing-3d/live": { samples: 127, drawn: 67, frames: "76484caf6d81843cbbfe0a62e99fcecb234354a6a9f5cd6a2698947f5928b8a7" },
};

/** Each field group, over every recording and route in order: a mismatch names the group that changed. */
const PINNED_GROUPS: Record<Group, string> = {
  clock: "b0188390cc5fa8980afcbed1b300bfd3728fdc16663162672e3e1cdd2e798c8d",
  ants: "88b526f53a25c8a361d9ab2b5ed438fe3a15152f78255f058ac981b998c1df1d",
  positions: "670b67f3558c6e2eb781abe24c841ba2ae77d2656a62a9d5081a8319de1fba54",
  facings: "34ac38dc5e6b2c14542f62349faac5369507be688cca4edb8062074013249e32",
  castes: "d68886fc2de9445415c2a0e6ccf6e197ea5271d209ab797bf72640b459feaf25",
  carrying: "f8ab18ba71f96fbd5687a9473bfdc0376edab568c9c9a79e3678af60fc549c7a",
  alphas: "bb5ad4b34fe49024e890797f38e619ea7cac5933673fb60fba30839123295b3a",
  walk: "12e0913516e2da25cc401f0dbbf6910f90ee008136ae73cbc00ca5e0cf4e76e7",
  corpses: "10b5cbb70133e39887de204c9003aabed36b4c6beda26d87b472d6d7ffaa5780",
  fights: "e6511707ce8a0f5165a440db9abaa2bc2c4b28cf1e78f2c14605409577f4804f",
  marks: "e2ac14f9cdbae9baea544a20fb8f699819b9ed9be95f1e64cf8d269951aac4dd",
  hits: "10b5cbb70133e39887de204c9003aabed36b4c6beda26d87b472d6d7ffaa5780",
  board: "33e316d140ee5ba32f463711c1c38106baa6910bbabd2ec1c4a953209af97289",
  story: "1e40d591487ca3a172aece2b9bdc549fecd006b086b397de999819cac7b73753",
};

describe("recordings made before flyers", () => {
  it("are the committed bytes", () => {
    for (const r of RECORDINGS) expect([r.name, load(r.path).sha]).toEqual([r.name, r.sha]);
  });

  it.each(RECORDINGS.flatMap((r) => ROUTES.map((route) => [r.name, route] as const)))(
    "%s plays on the %s route to the frames it gave before flyers were drawn", (name, route) => {
      const { samples, drawn, frames } = playedOf(name, route);
      expect({ samples, drawn, frames }).toEqual(PINNED_FRAMES[`${name}/${route}`]);
    });

  it("every frame field group is as it was before flyers were drawn", () => {
    const keys = RECORDINGS.flatMap((r) => ROUTES.map((route) => [r.name, route] as const));
    const groups = Object.fromEntries((Object.keys(GROUPS) as Group[]).map((g) =>
      [g, sha256(keys.map(([name, route]) => playedOf(name, route).groups[g]).join("\n"))]));
    expect(groups).toEqual(PINNED_GROUPS);
  });
});
