// No page of the site shows a harness phase on a match: the server still classifies and sends it, and the web code
// neither reads nor draws it.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { modeCopy } from "../../web/src/replay.ts";

const webSource = fileURLToPath(new URL("../../web/src/", import.meta.url));
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : /\.(ts|css|html)$/.test(entry.name) ? [join(dir, entry.name)] : []);

it("leaves no harness phase reading or wording anywhere in the web pages", () => {
  const found = files(webSource).filter(file => /harnessPhase|harness phase|Harness:|Harness from|effort mismatch|d1p-phase/i
    .test(readFileSync(file, "utf8")));
  expect(found).toEqual([]);
});

it("keeps a stored Model Index replay's mode line to its date, playing and ended, in 2D and 3D alike", () => {
  const id = "2026-11-10T10-32-43-581Z-1";
  const playing = modeCopy("replay", 2, false, "/", id, true);
  const ended = modeCopy("replay", 2, true, "/", id, true);
  expect(playing.detail).not.toMatch(/harness|round|mismatch/i);
  expect(ended.detail).toBe("· recording ended");
});
