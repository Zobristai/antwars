import { readFileSync } from "node:fs";
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertNoRetiredChrome, RETIRED_CHROME } from "../../web/capture/spectator-navigation.ts";

afterEach(() => vi.unstubAllGlobals());

describe("spectator capture watch navigation", () => {
  it("fails when a watch page shows the retired lobby or directory chrome, without dismissing anything", async () => {
    const count = vi.fn(async () => 0);
    const page = { locator: vi.fn(() => ({ count })) };
    await assertNoRetiredChrome(page as unknown as Pick<Page, "locator">);
    expect(page.locator).toHaveBeenCalledWith(RETIRED_CHROME);
    expect(RETIRED_CHROME).toBe("#aw-lobby-controls, .aw-lobby-open, #aw-match-directory");
    count.mockResolvedValueOnce(1);
    await expect(assertNoRetiredChrome(page as unknown as Pick<Page, "locator">))
      .rejects.toThrow("A watch page shows retired lobby or directory chrome");
  });

  it("times both engines from the owner write against the unchanged designed beat, retaining failed evidence", () => {
    const source = readFileSync(new URL("../../web/capture/spectator-access.ts", import.meta.url), "utf8");
    expect(source).not.toContain('if (target !== "webkit")');
    expect(source).toContain('const cursor = world.finalWrites.length');
    expect(source).toContain('value.lobbyId === match.lobbyId && value.origin === match.origin');
    expect(source.indexOf('const observation = until(')).toBeLessThan(source.indexOf('action().catch('));
    expect(source).toContain('timing.latencyMs = observedAt - write.writtenAt');
    expect(source).toContain('const designedAt = write.writtenAt + DESIGNED_RESULT_DELAY_MS');
    expect(source).toContain('timing.latenessMs <= RESULT_DEADLINE_SLACK_MS');
    expect(source).toContain('observedAt - designedAt <= RESULT_DEADLINE_SLACK_MS');
    expect(source).toContain('timing.writerTimestamp = new Date(write.writtenAt).toISOString()');
    expect(source).toContain('timing.visibleTimestamp = new Date(observedAt).toISOString()');
    for (const label of ['public-rated-attached', 'public-unrated-late', 'private-attached-revoked', 'private-renewed-late']) expect(source).toContain(`"${label}", resultTimings`);
    expect(source).toContain('passed: false, error: redact(error), resultTimings');
    expect(source).not.toContain('heartbeatMs'); // Never wait out the ordinary heartbeat to pass the deadline.
  });

  it("proves natural reopen and recovery without modifying served assets, the fixture clock or application state", () => {
    const source = readFileSync(new URL("../../web/capture/spectator-access.ts", import.meta.url), "utf8");
    const helper = readFileSync(new URL("../../web/capture/spectator-result-checks.ts", import.meta.url), "utf8");
    expect(source).toContain('await observeResultReconnect(page)');
    expect(source).toContain('if (mode !== "boardless") await checkResultReconnect(page, "automatic-30s", reconnectChecks, world.finalWrites, selected)');
    expect(source).toContain('await checkResultReconnect(page, "connection-recovery", reconnectChecks, world.finalWrites, selected)');
    expect(helper).toContain('LIVE_BUFFER_MS + TICK_MS + RESULT_BEAT_MS');
    expect(helper).toContain('stream.source.dispatchEvent(new Event("error"))');
    expect(helper).toContain('new MutationObserver(record)');
    expect(helper).toContain('requestAnimationFrame(loop)');
    expect(helper).toContain('value.full && value.lobbyId === match.lobbyId && value.origin === match.origin');
    expect(helper).toContain('await page.waitForTimeout(DESIGNED_RESULT_DELAY_MS + RESULT_DEADLINE_SLACK_MS)');
    expect(helper).not.toContain('page.route(');
    expect(helper).not.toContain('world.advance(');
    expect(source).toContain('resultTimings, reconnectChecks');
  });

  it("keeps observing rather than sleeping through initial result reveal or resetting on reconnect", () => {
    const helper = readFileSync(new URL("../../web/capture/spectator-result-checks.ts", import.meta.url), "utf8");
    expect(helper).toContain('animation.animationName === "aw-reveal"');
    expect(helper).toContain('animation.effect?.getTiming().duration === 520');
    expect(helper).toContain('layoutBaseline = layout(panelAtStart)');
    expect(helper).toContain('Result reveal never settled');
    expect(helper.match(/baseline\[0\] = current\[0\]!/g)).toHaveLength(1);
    expect(helper).not.toContain('animations: "disabled"');
    expect(helper).not.toContain('animation.cancel(');
    expect(helper).not.toContain('animation.finish(');
    expect(helper).not.toContain('waitForTimeout(520)');
  });

  it("attaches redacted console collection before navigation and retains it on failed cases", () => {
    const source = readFileSync(new URL("../../web/capture/spectator-access.ts", import.meta.url), "utf8");
    expect(source).toContain('const consoleOutput = captureConsole(page, redact)');
    expect(source.indexOf('captureConsole(page, redact)')).toBeLessThan(source.indexOf('await page.goto('));
    expect(source).toContain('passed: false, error: redact(error), resultTimings, reconnectChecks, images, requests, errors, consoleOutput');
  });

  it("checks every watch navigation and retains the original access and renderer assertions", () => {
    const source = readFileSync(new URL("../../web/capture/spectator-access.ts", import.meta.url), "utf8");
    expect(source).not.toContain("#aw-match-directory");
    expect(source).not.toContain(`page.locator('[data-sheet="agents"]')`);
    expect(source.match(/await assertNoRetiredChrome\(page\);/g)).toHaveLength(6);
    for (const response of ["selectedResponse", "privateResponse", "renewedLive"]) {
      expect(source).toMatch(new RegExp(`await ${response};\\s*await assertNoRetiredChrome\\(page\\);`));
    }
    for (const marker of ["lobby=${selected.lobbyId}", "lobby=${successor.lobbyId}", "&replay=${replayId}"]) {
      const line = source.split("\n").findIndex(value => value.includes("await page.goto") && value.includes(marker));
      expect(line).toBeGreaterThan(-1);
      expect(source.split("\n")[line]).toContain("watch=1");
      expect(source.split("\n").slice(line + 1, line + 3).join("\n")).toContain("await assertNoRetiredChrome(page)");
    }
    expect(source).toContain('for (const mode of ["2d", "3d", "boardless"] as const)');
    expect(source).toContain('world.advance(selected.untilReleaseMs() - 1)');
    expect(source).toMatch(/Rated board\/player state appeared before its 300-second floor"\);\s*await withResultTiming\(page, world, selected, "public-rated-attached", resultTimings, \(\) => selected\.play\(\)\);/);
    expect(source).toMatch(/Revoked invite admitted a new live request"\);\s*world\.advance\(privateMatch\.untilReleaseMs\(\) - 1\);\s*await withResultTiming\(page, world, privateMatch, "private-attached-revoked", resultTimings, \(\) => privateMatch\.play\(\)\);/);
    expect(source).not.toContain('world.advance(301000)');
    for (const assertion of ["Rated board/player state appeared before its 300-second floor", "Selected playback reloaded while its slot was reused", "Private match appeared in public discovery", "Revoked invite admitted a new live request", "Private recording opened without an invite", "Requested 3D fell back to another renderer"]) {
      expect(source).toContain(assertion);
    }
    expect(source).not.toMatch(/force\s*:\s*true|closeSelectedLobbyDialog|name:\s*["']Close["']/);
  });
});
