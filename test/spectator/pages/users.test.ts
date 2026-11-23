import { expect, it } from "vitest";
import { mountMatches } from "../../../web/src/pages/matches.ts";
import type { MatchesView } from "../../../web/src/matches-page/data.ts";
import type { PublicUser } from "../../../web/src/matches-page/users.ts";
import { dom } from "./dom.ts";

const empty = { status: "ready", rows: [] } as const;
const row = (i: number): PublicUser => ({ username: `user-${String(i).padStart(2,"0")}`, agents: ["sample", "sample/wing"], matches: 1+i, wins: i, losses: 0, own: 1,
  model: i ? "public model" : null, moreModels: i ? 1 : 0, ranked: i ? { rating: 1500.4, rd: 60, ratedMatches: i } : null, latest: { startedAt: "2026-11-01T00:00:00.000Z", id: "sample" } });
it("places Users before Recordings, sorts before paging, and leaves other lists' actions alone", () => {
  const p = dom(); const view: MatchesView = { live: empty, recordings: empty, waiting: empty, next: "older", users: { status: "ready", rows: Array.from({length:11}, (_,i) => row(10-i)) } };
  let rec = 0; const page = mountMatches(p.doc,p.doc.body,{ refresh() {}, more() { rec++; } }); page.update(view);
  expect(p.body.byClass("d1p-card-title").map(e => e.textContent)).toEqual(["Waiting", "Live now", "Users", "Recordings"]);
  const card = () => p.body.byClass("users-card")[0]!;
  const names = () => card().all().filter(e => e.tag === "strong").map(e => e.textContent);
  expect(names()).toHaveLength(10); expect(names()[0]).toBe("user-00"); expect(names()).not.toContain("user-10");
  expect(card().textContent).toContain("No model reported"); expect(card().textContent).toContain("Not ranked");
  const key = (k: string) => card().all().find(e => e.dataset.key === k)!;
  key("users-more").click(); expect(names()).toHaveLength(11); expect(rec).toBe(0);
  key("users-head-2").focus(); key("users-head-2").click(); expect(names()[0]).toBe("user-10"); expect(key("users-head-2").focused).toBe(true);
  expect(card().byClass("d1p-prov")).toHaveLength(9); expect(card().byClass("users-own")[0]?.textContent).toBe("+1 own");
  expect(card().byClass("users-replay")[0]!.href).toBe("/?replay=sample"); expect(card().byClass("users-more-models")[0]!.textContent).toBe("+1 more");
  key("users-head-2").click(); expect(names()[0]).toBe("user-00");
  for (const status of ["loading", "ready", "error"] as const) {
    page.update({ ...view, users: { status, rows: [] } });
    expect(card().byClass("d1p-state")[0]!.textContent).toBe({ ready: "No user has played yet", loading: "Loading users", error: "Users could not be loaded" }[status]);
    expect(card().all().some(n => n.tag === "button")).toBe(false);
  }
  page.destroy();
});
