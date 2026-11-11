// scripts/ci/playwright-image.ts reads the Playwright version from the running image's
// $PLAYWRIGHT_BROWSERS_PATH/.docker-info. Metadata that is not a JSON object with a string
// driverVersion must fail the step with a clear ::error:: (image version unknown, the pinned
// version), not throw. Each case runs the script against a temporary .docker-info, so no
// Playwright image is needed.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const pinned: string = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).devDependencies["playwright-core"];
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function runWithDockerInfo(content: string) {
  const dir = mkdtempSync(join(tmpdir(), "playwright-image-"));
  dirs.push(dir);
  writeFileSync(join(dir, ".docker-info"), content);
  const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: dir };
  delete env.GITHUB_ENV;
  return spawnSync(process.execPath, ["scripts/ci/playwright-image.ts"], { cwd: root, env, encoding: "utf8" });
}

describe("playwright-image.ts with unusable .docker-info", () => {
  const cases: [string, string, string][] = [
    ["JSON null", "null", "is not a JSON object"],
    ["a JSON number", "42", "is not a JSON object"],
    ["a JSON string", JSON.stringify(pinned), "is not a JSON object"],
    ["a JSON array", JSON.stringify([pinned]), "is not a JSON object"],
    ["an object without driverVersion", JSON.stringify({ dockerImageName: `mcr.microsoft.com/playwright:v${pinned}-noble` }), "has no driverVersion"],
    ["a non-string driverVersion", JSON.stringify({ driverVersion: 1.61 }), "has no driverVersion"],
  ];
  for (const [name, content, reason] of cases) {
    it(`fails with ::error:: for ${name}`, () => {
      const result = runWithDockerInfo(content);
      expect(result.status).toBe(1);
      expect(result.stderr).not.toMatch(/TypeError|Error:/);
      const errors = result.stdout.split("\n").filter((line) => line.startsWith("::error::"));
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(reason);
      expect(errors[0]).toContain(`image version unknown, package.json pins playwright-core ${pinned}`);
    });
  }
});
