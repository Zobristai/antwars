import { readFileSync, readdirSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { mountMatches } from "../../web/src/pages/matches.ts";
import type { MatchesView } from "../../web/src/matches-page/data.ts";
import { dom, type ElementPort } from "./pages/dom.ts";

it("Matches renders only catalog-live and saved-recording rows, including a truly empty live list", () => {
  const port = dom({ search: "?board=2d&invite=secret" });
  const host = port.doc.createElement("div") as unknown as ElementPort; port.body.append(host);
  const refresh = vi.fn(), more = vi.fn();
  const mounted = mountMatches(port.doc, host as unknown as HTMLElement, { refresh, more });
  // The wide tables' row actions (the stacked rows repeat them for narrow cards).
  const links = () => host.byClass("d1p-wide").flatMap(table => table.byClass("d1p-row-pill"));
  const view: MatchesView = { waiting: { status: "ready", rows: [] }, live: { status: "ready", rows: [] }, recordings: { status: "ready", rows: [] }, next: null };
  mounted.update(view);
  expect(host.byClass("d1p-live")).toEqual([]);
  mounted.update({ ...view,
    live: { status: "ready", rows: [{ lobbyId: "ongoing", startedAt: 1, rated: false, delaySeconds: 60, colonies: [[], []] }] },
    recordings: { status: "ready", rows: [{ id: "2026-10-21T13-58-00-000Z-1", startedAt: "2026-10-21T13:58:00Z", endedAt: null, simulationEndedAt: null,
      winner: null, reason: null, decidedBy: null, seats: [{ seat: 0, colony: 0, modelLabel: null, thinkingLevel: null, serviceTier: null, handle: "alice" }, { seat: 1, colony: 1, modelLabel: null, thinkingLevel: null, serviceTier: null, handle: "bob" }], status: "partial", unavailable: [] }] },
  });
  expect(links().map(row => row.href)).toEqual(["/?lobby=ongoing&watch=1&board=2d", "/?replay=2026-10-21T13-58-00-000Z-1&board=2d"]);
  expect(host.textContent).not.toMatch(/Watch current playback|Recent upload|recent uploads/);
  mounted.update(view);
  expect(links()).toEqual([]);
  mounted.destroy();
});

it("2D, 3D and boardless use the same source and advance through its automatic-only selection hook", () => {
  const two = readFileSync(new URL("../../web/src/main.ts", import.meta.url), "utf8");
  const three = readFileSync(new URL("../../web/src/board3d/main3d.ts", import.meta.url), "utf8");
  expect(two.match(/await openSource\(/g)).toHaveLength(2);
  expect(two.match(/input.nextMatch\(\)/g)).toHaveLength(2);
  expect(three.match(/await openSource\(/g)).toHaveLength(1);
  expect(three.match(/input.nextMatch\(\)/g)).toHaveLength(1);
  expect(two + three).not.toContain("link.reopen()");
});

it("no user-served module contains a retired main-match request path", () => {
  const files = readdirSync(new URL("../../web/src/", import.meta.url), { recursive: true, encoding: "utf8" }).filter(path => path.endsWith(".ts"));
  const users = files.filter(path => /["'`]\/live\//.test(readFileSync(new URL(`../../web/src/${path}`, import.meta.url), "utf8")));
  expect(users).toEqual([]);
});
