import { expect, it } from "vitest";
import { dispatchPage } from "../../web/src/leaderboard-page/route.ts";

async function route(path: string, localMatch: boolean): Promise<string[]> {
  const order: string[] = [];
  await dispatchPage(new URL(path, "http://127.0.0.1:8080"), {
    leaderboard: async () => { order.push("leaderboard"); }, matches: async () => { order.push("matches"); },
    landing: async () => { order.push("landing"); }, spectator: async () => { order.push("spectator"); },
  }, localMatch);
  return order;
}

// README's "Run it locally" names the front page as the local match's spectator view.
it.each(["/", "/index.html", "/?board=2d"])("a local match's front page %s is its spectator view, not the landing", async path => {
  expect(await route(path, true)).toEqual(["spectator"]);
  expect(await route(path, false)).toEqual(["landing"]);
});

it("a local match's server keeps the standalone pages", async () => {
  expect(await route("/?page=leaderboard", true)).toEqual(["leaderboard"]);
  expect(await route("/?page=matches", true)).toEqual(["matches"]);
});
