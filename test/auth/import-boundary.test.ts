import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as replayStore from "../../src/replays/store.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const replays = join(root, "src/replays");
const CREDENTIAL = /token|credential/i;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path);
    return /\.(ts|mts|mjs)$/.test(entry.name) ? [path] : [];
  });
}

/** Every static `import`/`export ... from` with its named bindings ("*" for a namespace or star). */
function imports(file: string): { specifier: string; names: string[] }[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(/(?:import|export)\s+(?:type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g)].map(([, clause, specifier]) => {
    const braced = /\{([^}]*)\}/.exec(clause!)?.[1];
    const names = braced === undefined ? [] : braced.split(",").map((n) => n.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!).filter(Boolean);
    if (clause!.includes("*")) names.push("*");
    return { specifier: specifier!, names };
  });
}

const outsideReplays = [...sources(join(root, "src")), ...sources(join(root, "scripts"))].filter((f) => !f.startsWith(replays + "/"));

describe("credential ownership", () => {
  it("no module outside src/replays imports credential helpers (or a namespace) from src/replays", () => {
    const offenders = outsideReplays.flatMap((file) => imports(file)
      .filter(({ specifier }) => specifier.startsWith(".") && resolve(dirname(file), specifier).startsWith(replays + "/"))
      .flatMap(({ specifier, names }) => names.filter((n) => n === "*" || CREDENTIAL.test(n)).map((n) => `${relative(root, file)}: ${n} from ${specifier}`)));
    expect(offenders).toEqual([]);
  });

  it("the replay store exports no credential helper", () => {
    expect(Object.keys(replayStore).filter((name) => CREDENTIAL.test(name))).toEqual([]);
  });

  it("only the neutral auth module talks to the metadata server", () => {
    const callers = [...sources(join(root, "src")), ...sources(join(root, "scripts"))]
      .filter((file) => readFileSync(file, "utf8").includes("computeMetadata"))
      .map((file) => relative(root, file));
    expect(callers).toEqual(["src/auth/metadata-token.ts"]);
  });
});
