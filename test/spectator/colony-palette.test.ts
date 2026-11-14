// The page's colony colours follow its match's names: a match that carries none (every rated match) keeps colony 0's
// amber and colony 1's cyan and its steppe shaders exactly; a drawn pair shows each name's own colour. Every agent shows
// its colony's one colour, rated matches included.
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { COLONY_NAMES } from "../../src/sim/config.ts";
import { SUPERCOLONY_NAMES, colourCss } from "../../src/sim/colonyNames.ts";
import { COLONY_TINT } from "../../web/src/ants.ts";
import { COLONY_RGB } from "../../web/src/territory.ts";
import { TEXT_GROUND, colonyRgb, colonyTint, colonyWash, setMatchColonies } from "../../web/src/colony-palette.ts";
import { agentShade } from "../../web/src/squads.ts";
import { STEPPE_LOOK } from "../../web/src/ui/steppe-look.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
/** A document's root style and attributes, as far as the palette writes them. */
const fakeDocument = () => {
  const props = new Map<string, string>(), attrs = new Map<string, string>();
  const documentElement = {
    style: { setProperty: (name: string, value: string) => props.set(name, value), removeProperty: (name: string) => props.delete(name) },
    setAttribute: (name: string, value: string) => attrs.set(name, value), removeAttribute: (name: string) => attrs.delete(name),
  };
  return { props, attrs, doc: { documentElement } as unknown as Document };
};

afterEach(() => setMatchColonies(COLONY_NAMES));

// The two added colours, read from the table: the one place they are set.
const SWEETWATER = SUPERCOLONY_NAMES[2].colour, LAKE_SKINNER = SUPERCOLONY_NAMES[3].colour;
const channels = (rgb: number) => [((rgb >> 16) & 255) / 255, ((rgb >> 8) & 255) / 255, (rgb & 255) / 255];

describe("the page's colony colours", () => {
  it("are the rated colours and steppe shaders, byte for byte, while the match carries no names, with every agent in its colony's colour", () => {
    expect([colonyTint(0), colonyTint(1)]).toEqual([...COLONY_TINT]);
    expect([colonyRgb(0), colonyRgb(1)]).toEqual(COLONY_RGB);
    const team = ([0, 1, 1, 0, 0, 1, 0, 1] as const).map(colony => ({ colony }));
    expect(team.map((a, i) => agentShade(a.colony, i, team))).toEqual(team.map(a => (a.colony === 0 ? 0xffb000 : 0x00c2ff)));
    // The steppe look's shader text as main built it before colonies had their own colours.
    expect(sha(STEPPE_LOOK.board2d.fill(""))).toBe("89f71ab4be54fbf492617fd7245bca4718af5ee2c86f524c76206e7ff3db3d3c");
    expect(sha(STEPPE_LOOK.board2d.front(""))).toBe("b6a2a071eafda1373aa22fef5f45b31aaa51437599f0c193f104163ff20ddb52");
    expect(sha(STEPPE_LOOK.board3d.ground("definitions", ""))).toBe("ee225474b2c4d3682e29071001918cce01ff4281e27b87c8d16d884ddbc44949");
  });

  it("follow a drawn pair: each colony its name's colour for every one of its agents, its wash, and the page's colony CSS colours", () => {
    const { props, attrs, doc } = fakeDocument();
    setMatchColonies(["Sweetwater Colony", "Very Large Colony"], doc);
    expect([colonyTint(0), colonyTint(1)]).toEqual([SWEETWATER, 0xffb000]);
    expect(colonyRgb(0)).toEqual(channels(SWEETWATER));
    // Sweetwater's text needs a dark ground for 4.5:1 on a raised row; Very Large's does not (colony-ground.css).
    expect(props).toEqual(new Map([["--aw-k0", colourCss(SWEETWATER)], ["--aw-k1", "#ffb000"], ["--aw-ink-ground", colourCss(TEXT_GROUND)]]));
    expect(attrs).toEqual(new Map([["data-aw-ground", "0"]]));
    expect(colonyWash(0).hue).not.toEqual(colonyWash(1).hue);
    // Its wash is its own colour, slightly darkened.
    expect(STEPPE_LOOK.board2d.fill("")).toContain(`vec3(${channels(SWEETWATER).map(c => (c * 0.92).toFixed(4)).join(", ")})`);
    // Every agent shows its colony's one colour: Sweetwater's on colony 0, Very Large's on colony 1.
    const agents = [{ colony: 0 }, { colony: 1 }, { colony: 0 }, { colony: 1 }] as const;
    expect(agents.map((a, i) => agentShade(a.colony, i, agents))).toEqual([SWEETWATER, 0xffb000, SWEETWATER, 0xffb000]);
    // Back to a match with no names: the rated colours, and no ground.
    setMatchColonies(COLONY_NAMES, doc);
    expect(props).toEqual(new Map([["--aw-k0", "#ffb000"], ["--aw-k1", "#00c2ff"]]));
    expect(attrs.size).toBe(0);
  });

  it("keep a colony's own colour for a name outside the table", () => {
    setMatchColonies(["Some Colony", "Lake Skinner Colony"]);
    expect([colonyTint(0), colonyTint(1)]).toEqual([0xffb000, LAKE_SKINNER]);
    expect(agentShade(1, 0, [{ colony: 1 }])).toBe(LAKE_SKINNER);
  });

  it("keep the classic colours, wash and steppe shaders for a name that is an inherited member, such as constructor", () => {
    const classic = { tint: [colonyTint(0), colonyTint(1)], wash: [colonyWash(0), colonyWash(1)], fill: STEPPE_LOOK.board2d.fill(""),
      front: STEPPE_LOOK.board2d.front(""), ground: STEPPE_LOOK.board3d.ground("definitions", "") };
    setMatchColonies(["constructor", "toString"]);
    expect([colonyTint(0), colonyTint(1)]).toEqual(classic.tint);
    expect([colonyWash(0), colonyWash(1)]).toEqual(classic.wash);
    for (const colony of [0, 1]) {
      const { hue, depth } = colonyWash(colony);
      expect(hue.every(c => Number.isFinite(c))).toBe(true);
      expect(Number.isFinite(depth)).toBe(true);
    }
    expect(STEPPE_LOOK.board2d.fill("")).toBe(classic.fill);
    expect(STEPPE_LOOK.board2d.front("")).toBe(classic.front);
    expect(STEPPE_LOOK.board3d.ground("definitions", "")).toBe(classic.ground);
  });
});
