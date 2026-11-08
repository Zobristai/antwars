import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { allowedLeaderboardRequest, expectedView, fakeLeaderboardPage, fakeLeaderboardRanking, fakeReadOf, FIXTURE_CURSOR, LEADERBOARD_MODES, LEADERBOARD_SCENES, LEADERBOARD_VIEWPORTS, MODE_LABELS, navReachExempt, touchViewport, type FakeRead } from "./leaderboard-stills.ts";
import { readLeaderboard } from "../src/leaderboard.ts";
import { BOARD_GROUPS, CHALLENGE_SIZE, OPENING_MODE, sizeOf, tableTitle } from "../src/pages/model.ts";
import { C } from "../src/leaderboard-page/copy.ts";

const endpoint = "http://localhost:4718/api/leaderboard";
const READS: FakeRead[] = ["house", "everyone", "house-mode"];
describe("strict fake-only leaderboard captures", () => {
  it("covers the four agreed viewports and distinct states, including mode switching and a house size, without any recording", () => {
    expect(LEADERBOARD_VIEWPORTS).toEqual([[1920, 1080], [390, 844], [844, 390], [360, 800]]);
    expect(LEADERBOARD_SCENES).toEqual(["populated", "partial", "paginated", "empty", "failure", "loading", "disabled", "mode-switch", "house-mode"]);
    expect(LEADERBOARD_MODES).toEqual(["1v1", "2v2", "3v3", "4v4", "house-1v1", "house-2v2", "house-3v3", "house-4v4"]);
    const stills = readFileSync(new URL("./stills.ts", import.meta.url), "utf8");
    expect(stills.indexOf('if (values["leaderboard-scenes"])')).toBeLessThan(stills.indexOf('if (!values.recording || !values.out)'));
  });
  it("holds only the touch viewports to the 44 px tap height; desktop keeps the on-screen checks only", () => {
    expect(LEADERBOARD_VIEWPORTS.map(([width, height]) => [`${width}x${height}`, touchViewport(width)])).toEqual([
      ["1920x1080", false], ["390x844", true], ["844x390", true], ["360x800", true],
    ]);
  });
  it("exempts only 360x800 from the Leaderboard nav link's on-screen check", () => {
    expect(LEADERBOARD_VIEWPORTS.map(([width, height]) => [`${width}x${height}`, navReachExempt(width, height)])).toEqual([
      ["1920x1080", false], ["390x844", false], ["844x390", false], ["360x800", true],
    ]);
    const source = readFileSync(new URL("./leaderboard-stills.ts", import.meta.url), "utf8");
    // The exemption reaches the one link and the edge check only; the height and hit checks stay on every control.
    expect(source).toContain('navExempt && node.matches(".d1-top .d2-nav-link") && node.textContent === "Leaderboard"');
    expect(source).toContain("(touch && box.height < 44) || offScreen || !hit || !node.contains(hit)");
  });
  it("expects the page's own board choices, opening board and table headings", () => {
    expect(MODE_LABELS).toEqual([...BOARD_GROUPS.flatMap(group => group.modes.map(mode => `${group.label} ${sizeOf(mode)}`)), `${C.challengeTitle} ${CHALLENGE_SIZE}`]);
    const opening = BOARD_GROUPS.find(group => group.modes.includes(OPENING_MODE))!;
    expect(expectedView("populated")).toMatchObject({ headings: tableTitle({ id: "aw-house-mode-ranking", title: "" }, OPENING_MODE), pressed: `${opening.label} ${sizeOf(OPENING_MODE)}` });
    expect(expectedView("house-mode").headings).toBe(tableTitle({ id: "aw-house-mode-ranking", title: "" }, "house-2v2"));
    expect(expectedView("mode-switch").headings).toBe(["aw-house-ranking", "aw-everyone-ranking"].map(id => tableTitle({ id, title: "" }, "4v4")).join("|"));
    expect(expectedView("failure").headings).toBe(["aw-house-ranking", "aw-everyone-ranking"].map(id => tableTitle({ id, title: "" }, "1v1")).join("|"));
  });
  it("uses the real schema and explicitly fake rows; every read keeps descending order and the everyone read includes house agents", () => {
    for (const read of READS) {
      const pages = [fakeLeaderboardPage(read), fakeLeaderboardPage(read, FIXTURE_CURSOR), fakeLeaderboardRanking(read)].map(value => readLeaderboard(value)!);
      expect(pages.every(Boolean)).toBe(true);
      const rows = pages[2]!.entries;
      expect(rows).toEqual([...pages[0]!.entries, ...pages[1]!.entries]);
      expect(rows.map(row => row.rating)).toEqual(rows.map(row => row.rating).sort((a, b) => b - a));
      expect(rows.every(row => row.ratedMatches >= 1)).toBe(true);
    }
    const everyone = fakeLeaderboardRanking("everyone").entries.map(row => row.displayName);
    expect(fakeLeaderboardRanking("house").entries.every(row => everyone.includes(row.displayName))).toBe(true);
    expect(everyone).toContain("<img onerror=alert(1)>");
    expect(() => fakeLeaderboardPage("house", "unknown")).toThrow("Unexpected fake cursor");
  });
  it("allows only exact anonymous reads by mode, with the house scope only on a public mode", () => {
    for (const mode of LEADERBOARD_MODES) for (const cursor of [undefined, FIXTURE_CURSOR]) {
      const payload = { limit: 50, mode, ...(cursor ? { cursor } : {}) };
      expect(allowedLeaderboardRequest(endpoint, "POST", JSON.stringify(payload), { "content-type": "application/json" })).toBe(true);
      expect(allowedLeaderboardRequest(endpoint, "POST", JSON.stringify({ ...payload, scope: "house" }), {})).toBe(!mode.startsWith("house-"));
    }
    expect(fakeReadOf({ mode: "2v2", scope: "house" })).toBe("house");
    expect(fakeReadOf({ mode: "2v2" })).toBe("everyone");
    expect(fakeReadOf({ mode: "house-2v2" })).toBe("house-mode");
  });
  it.each([
    [endpoint, "GET", null, {}],
    [endpoint, "POST", '{"limit":50}', {}],
    [endpoint, "POST", '{"limit":50,"mode":"5v5"}', {}],
    [endpoint, "POST", '{"limit":50,"mode":"1v1","scope":"everyone"}', {}],
    [endpoint, "POST", '{"limit":50,"mode":"house-1v1","scope":"house"}', {}],
    [endpoint, "POST", '{"limit":50,"mode":"1v1","key":"fake"}', {}],
    [endpoint, "POST", '{"limit":50,"mode":"1v1","cursor":"other"}', {}],
    [endpoint, "POST", '{"limit":100,"mode":"1v1"}', {}],
    [endpoint, "POST", '[]', {}],
    [endpoint, "POST", 'null', {}],
    [endpoint, "POST", '{', {}],
    [endpoint, "POST", '{"limit":50,"mode":"1v1"}', { Authorization: "fake" }],
    [endpoint, "POST", '{"limit":50,"mode":"1v1"}', { Cookie: "fake" }],
    [endpoint, "POST", '{"limit":50,"mode":"1v1"}', { "X-API-Key": "fake" }],
    [endpoint + "?key=fake", "POST", '{"limit":50,"mode":"1v1"}', {}],
    [endpoint + "#invite=fake", "POST", '{"limit":50,"mode":"1v1"}', {}],
    ["https://live.example/api/leaderboard", "POST", '{"limit":50,"mode":"1v1"}', {}],
    ["http://localhost:4718/api/claim_username", "POST", '{"limit":50,"mode":"1v1"}', {}],
  ] as [string, string, string | null, Record<string, string>][])("blocks unexpected request %s %s %s", (url, method, body, headers) => {
    expect(allowedLeaderboardRequest(url, method, body, headers)).toBe(false);
  });
});
