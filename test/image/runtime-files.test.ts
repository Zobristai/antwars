/// <reference types="node" />
// The runtime image carries exactly the src modules its commands import (one earlier release shipped
// an image missing one). Roots are every command run inside the image: the Dockerfile CMD and each
// `--command npm --args run,<script>` in deploy/cloud-run/deploy.sh, plus the files those modules
// load by `new URL("...", import.meta.url)` (worker entry points and the ts-resolve loader).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

function stages(dockerfile: string): { header: string; lines: string[] }[] {
  const out: { header: string; lines: string[] }[] = [];
  for (const line of dockerfile.split("\n")) {
    if (/^FROM\s/.test(line)) out.push({ header: line, lines: [] });
    else out.at(-1)?.lines.push(line);
  }
  return out;
}

/** The npm scripts run inside the image. */
function imageScripts(dockerfile: string): string[] {
  const cmd = /^CMD\s+\["npm",\s*"start"\]/m.test(dockerfile) ? ["start"] : [];
  const deploy = [...read("deploy/cloud-run/deploy.sh").matchAll(/--command npm --args run,([\w-]+)/g)].map(m => m[1]!);
  return [...new Set([...cmd, ...deploy])];
}

/** Every repository file a script loads: its --import loader and its entry module. */
function scriptFiles(script: string): string[] {
  const command = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts[script];
  if (command === undefined) throw new Error(`package.json has no script ${script}`);
  return command.split(/\s+/).filter(arg => /^\.?\/?(src|web)\/\S+\.(ts|mjs)$/.test(arg)).map(arg => arg.replace(/^\.\//, ""));
}

function resolveSpecifier(from: string, specifier: string): string | null {
  const path = resolve(dirname(join(ROOT, from)), specifier);
  for (const candidate of [path, path.replace(/\.js$/, ".ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return relative(ROOT, candidate);
  }
  return null;
}

/** Runtime import closure; type-only imports and exports are erased and are not followed. */
function closure(roots: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = read(file);
    const specifiers = [
      ...[...source.matchAll(/(?:^|\n)\s*(?:import|export)\s+(type\s+)?[^;]*?\bfrom\s*["']([^"']+)["']/g)].filter(m => m[1] === undefined).map(m => m[2]!),
      ...[...source.matchAll(/(?:^|\n)\s*import\s*["']([^"']+)["']/g)].map(m => m[1]!),
      ...[...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map(m => m[1]!),
      ...[...source.matchAll(/new URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g)].map(m => m[1]!),
    ];
    for (const specifier of specifiers) {
      if (!specifier.startsWith(".")) continue;
      const target = resolveSpecifier(file, specifier);
      if (target === null) throw new Error(`${file}: cannot resolve ${specifier}`);
      pending.push(target);
    }
  }
  return seen;
}

describe("runtime image files", () => {
  const dockerfile = read("Dockerfile");
  const all = stages(dockerfile);
  const pruneStage = all.find(stage => /^FROM build AS runtime-src\b/.test(stage.header));
  const runtime = all.at(-1)!;

  it("copies src into the runtime stage only from the pruned stage, so no layer holds a pruned file", () => {
    expect(pruneStage, "a `FROM build AS runtime-src` stage").toBeDefined();
    const srcCopies = runtime.lines.filter(line => /^COPY\b.*\s\.\/src\s*$/.test(line));
    expect(srcCopies).toEqual(["COPY --from=runtime-src /app/src ./src"]);
  });

  it("prunes exactly the src files no image command reaches, and keeps every one it does", () => {
    const rm = pruneStage!.lines.find(line => line.startsWith("RUN rm -r "));
    expect(rm, "the runtime-src stage's `RUN rm -r` line").toBeDefined();
    const pruned = rm!.slice("RUN rm -r ".length).trim().split(/\s+/);
    const isPruned = (file: string) => pruned.some(path => file === path || file.startsWith(`${path}/`));

    const scripts = imageScripts(dockerfile);
    expect(scripts).toEqual(expect.arrayContaining(["start", "record-service"]));
    const reached = closure(scripts.flatMap(scriptFiles));

    const srcFiles = readdirSync(join(ROOT, "src"), { recursive: true }).map(String)
      .map(path => `src/${path}`).filter(path => statSync(join(ROOT, path)).isFile() && !path.endsWith(".test.ts"));
    expect([...reached].filter(file => file.startsWith("src/") && isPruned(file)), "reached but pruned").toEqual([]);
    expect(srcFiles.filter(file => !reached.has(file) && !isPruned(file)), "unreached but shipped").toEqual([]);
    for (const path of pruned) expect(existsSync(join(ROOT, path)), `${path} exists`).toBe(true);

    // Reached modules outside src must each be copied into the runtime stage on their own.
    for (const file of [...reached].filter(file => !file.startsWith("src/"))) {
      expect(runtime.lines, file).toContain(`COPY ${file} ./${file}`);
    }
  });
});
