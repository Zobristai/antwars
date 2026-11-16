// Node fixture smoke test: proves the install used this branch's
// package.json and pnpm-lock.yaml. The repository's older package-lock.json
// resolves a different Vitest and no `playwright` package, so an install that
// picked it fails here.
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

function installedVersion(name: string): string {
  return (require(`${name}/package.json`) as { version: string }).version;
}

describe("node validation fixture", () => {
  it("runs the pinned Vitest", () => {
    expect(installedVersion("vitest")).toBe("3.2.7");
  });

  it("resolves the pinned Playwright package", () => {
    expect(installedVersion("playwright")).toBe("1.61.1");
  });
});
