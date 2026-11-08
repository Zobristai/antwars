/// <reference types="node" />
// The private identifier and secret checks: .githooks/identifier-config, the pre-commit hook
// and the gitleaks workflow's scan (.github/scripts/identifiers-scan.sh). Every identifier
// here is synthetic. The hook and scan cases need gitleaks (8.30.1, as CI installs it) on
// PATH or named by ANTWAR_GITLEAKS; without it they are skipped, and the run reports them
// as skipped.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const generator = join(root, ".githooks/identifier-config");
const trustedFiles = [
  ".githooks/pre-commit",
  ".githooks/identifier-config",
  ".github/scripts/identifiers-scan.sh",
  ".github/workflows/gitleaks.yml",
  ".gitleaks-defaults.toml",
];

// One synthetic stand-in per identifier slot, including regex metacharacters and a quote.
const SLOTS = [
  "synthetic-host-q7k2",
  "synthetic-project.x9",
  "8765432109",
  "owner+one@synthetic.invalid",
  "svc(a)|b[c]{2}^$*?\\synthetic",
  "it's-synthetic",
];
const LIST = SLOTS.join("\n") + "\n";

function findGitleaks(): string | undefined {
  const named = process.env.ANTWAR_GITLEAKS;
  if (named && existsSync(named)) return dirname(named);
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, "gitleaks"))) return dir;
  }
  return undefined;
}
const gitleaksDir = findGitleaks();
const env = {
  ...process.env,
  PATH: gitleaksDir ? `${gitleaksDir}${delimiter}${process.env.PATH ?? ""}` : (process.env.PATH ?? ""),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Synthetic Tester",
  GIT_AUTHOR_EMAIL: "tester@example.invalid",
  GIT_COMMITTER_NAME: "Synthetic Tester",
  GIT_COMMITTER_EMAIL: "tester@example.invalid",
};
delete (env as Record<string, string | undefined>).ANTWARS_IDENTIFIERS;

const temps: string[] = [];
afterAll(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "antwar-identifiers-"));
  temps.push(d);
  return d;
}

type Run = { status: number | null; out: string };
function run(cmd: string, args: string[], opts: { cwd?: string; input?: string; extraEnv?: Record<string, string | undefined> } = {}): Run {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...env, ...opts.extraEnv })) if (v !== undefined) merged[k] = v;
  const r = spawnSync(cmd, args, { cwd: opts.cwd, input: opts.input, env: merged, encoding: "utf8" });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
function git(cwd: string, ...args: string[]): string {
  const r = run("git", args, { cwd });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.out}`);
  return r.out.trim();
}
function write(dir: string, path: string, text: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}
/** Asserts that no synthetic identifier appears in `text`, in any letter case. */
function expectNoValue(text: string): void {
  const lower = text.toLowerCase();
  for (const value of SLOTS) expect(lower.includes(value.toLowerCase()), `output contains slot value ${SLOTS.indexOf(value) + 1}`).toBe(false);
}
/** A synthetic GitHub token, assembled at run time so this file never holds one. */
function syntheticToken(): string {
  return "gh" + "p_" + "Q7x2Lm9Kd4Rt8Vz1Nw6Bp3Hs5Jc0Fy2Ga4Ue7Io";
}
/** The concatenated contents of every file under `dir`. */
function readTree(dir: string): string {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => readFileSync(join(e.parentPath, e.name), "utf8"))
    .join("\n");
}

/** A repository whose first commit holds the trusted check files, as on main. */
function baseRepo(): { repo: string; base: string } {
  const repo = temp();
  git(repo, "init", "-q", "-b", "main");
  for (const f of trustedFiles) {
    mkdirSync(dirname(join(repo, f)), { recursive: true });
    copyFileSync(join(root, f), join(repo, f));
  }
  chmodSync(join(repo, ".githooks/pre-commit"), 0o755);
  write(repo, "README.md", "synthetic base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "--no-verify", "-m", "base");
  return { repo, base: git(repo, "rev-parse", "HEAD") };
}

describe("identifier-config builds the identifier rules from the list", () => {
  const gen = (input: string) => run("sh", [generator], { input });

  it("writes one lower-cased, case-insensitive rule per identifier, with every metacharacter escaped", () => {
    const r = gen("A.b+C*\nx(y)|z\nit's\\end\n");
    expect(r.status).toBe(0);
    expect(r.out).toContain(`id = "private-identifier-1"\n`);
    expect(r.out).toContain("regex = '''(?i)a\\.b\\+c\\*'''");
    expect(r.out).toContain("regex = '''(?i)x\\(y\\)\\|z'''");
    expect(r.out).toContain("regex = '''(?i)it\\x27s\\\\end'''");
    expect(r.out).toContain(`id = "private-identifier-3"\n`);
    expect(r.out).not.toContain("private-identifier-4");
  });

  it("builds every rule whether or not the list ends with LF, and a final LF is not a blank line", () => {
    const withLf = gen(LIST);
    const withoutLf = gen(LIST.slice(0, -1));
    expect(withLf.status).toBe(0);
    expect(withoutLf.status).toBe(0);
    expect(withoutLf.out).toBe(withLf.out);
    expect(withLf.out).toContain(`id = "private-identifier-${SLOTS.length}"`);
    expect(withLf.out).not.toContain(`private-identifier-${SLOTS.length + 1}`);
  });

  it("skips blank and whitespace-only lines, numbering the identifiers that remain", () => {
    const r = gen("\nsynthetic-one\n\n  \t\nsynthetic-two\n\n");
    expect(r.status).toBe(0);
    expect(r.out).toContain(`id = "private-identifier-1"\n`);
    expect(r.out).toContain("regex = '''(?i)synthetic-two'''");
    expect(r.out).toContain(`id = "private-identifier-2"\n`);
    expect(r.out).not.toContain("private-identifier-3");
    expect(r.out).not.toContain("regex = '''(?i)'''");
  });

  it.each([
    ["empty input", "", "the identifier list has no identifiers"],
    ["a whitespace-only list", " \n\t\n\n", "the identifier list has no identifiers"],
    ["a CR line ending", "synthetic-one\r\n", "line 1 contains a CR"],
    ["a CR-only line", "synthetic-one\n\r\n", "line 2 contains a CR"],
    ["a control character", "synthetic\u0001one\n", "line 1 contains a control character"],
  ])("refuses %s, naming only the line, and writes no config", (_name, input, message) => {
    const r = gen(input);
    expect(r.status).toBe(1);
    expect(r.out).toContain(message);
    expect(r.out).not.toContain("[[rules]]");
    expect(r.out).not.toContain("synthetic");
  });
});

describe.skipIf(!gitleaksDir)("identifier rules under gitleaks (needs gitleaks)", { timeout: 60_000 }, () => {
  function scan(list: string, content: string): Run {
    const dir = temp();
    const cfg = run("sh", [generator], { input: list });
    writeFileSync(join(dir, "rules.toml"), cfg.out);
    write(dir, "data/f.txt", content);
    return run("gitleaks", ["dir", "data", "--no-banner", "--redact", "--config", join(dir, "rules.toml")], { cwd: dir });
  }

  it("matches each value literally, ignoring case", () => {
    expect(scan("a.b+c\n", "xx A.B+C yy\n").status).toBe(1);
    expect(scan("a.b+c\n", "xx aXbbbc yy\n").status).toBe(0);
    expect(scan("svc(a)|b\n", "svc(a)|b\n").status).toBe(1);
    expect(scan("svc(a)|b\n", "b\n").status).toBe(0);
    expect(scan("it's\n", "IT'S\n").status).toBe(1);
  });
});

describe.skipIf(!gitleaksDir)("pre-commit hook (needs gitleaks)", { timeout: 60_000 }, () => {
  /** A clone-like repository whose origin/main is the base, with main's hook installed in .git/hooks as CONTRIBUTING.md describes. */
  function hookRepo(withList: boolean): string {
    const { repo } = baseRepo();
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    const hook = join(repo, ".git/hooks/pre-commit");
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, git(repo, "cat-file", "blob", "origin/main:.githooks/pre-commit") + "\n");
    chmodSync(hook, 0o755);
    if (withList) writeFileSync(join(repo, ".git/antwars-identifiers"), LIST);
    return repo;
  }
  /** A generator that, if it ever ran, would copy the list it receives into `leak`. */
  function leakingGenerator(leak: string): string {
    return `#!/bin/sh\ncat > '${leak}'\necho 'title = "none"'\n`;
  }
  function commit(repo: string, path: string, text: string): Run {
    write(repo, path, text);
    git(repo, "add", path);
    return run("git", ["commit", "-q", "-m", "change"], { cwd: repo });
  }

  it.each(SLOTS.map((v, i) => [i + 1, v] as const))("refuses a commit carrying slot %i, in any case, naming only the rule", (slot, value) => {
    const repo = hookRepo(true);
    const r = commit(repo, `notes/slot-${slot}.txt`, `see ${value.toUpperCase()} here\n`);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain(`private-identifier-${slot}`);
    expectNoValue(r.out);
    expect(git(repo, "rev-list", "--count", "HEAD")).toBe("1");
  });

  it("reads the list from the main .git directory in a linked worktree", () => {
    const repo = hookRepo(true);
    const wt = join(temp(), "wt");
    git(repo, "worktree", "add", "-q", "-b", "side", wt);
    const r = commit(wt, "notes/side.txt", `${SLOTS[0]}\n`);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("private-identifier-1");
    expectNoValue(r.out);
  });

  it("skips the identifier scan with a visible notice when .git/antwars-identifiers is absent", () => {
    const repo = hookRepo(false);
    const r = commit(repo, "notes/slot.txt", `${SLOTS[0]}\n`);
    expect(r.status).toBe(0);
    expect(r.out).toContain("NOTICE");
    expect(r.out).toContain("antwars-identifiers is absent, so the private identifier scan is SKIPPED");
  });

  it("still runs the defaults scan without the list", () => {
    const repo = hookRepo(false);
    const r = commit(repo, "src/config.txt", `${syntheticToken()}\n`);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("github-pat");
    expect(r.out).not.toContain(syntheticToken());
  });

  it("refuses an invalid list instead of skipping", () => {
    const repo = hookRepo(false);
    writeFileSync(join(repo, ".git/antwars-identifiers"), "synthetic-one\r\n");
    const r = commit(repo, "notes/ok.txt", "clean\n");
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("line 1 contains a CR");
  });

  it("never shows a file name that holds an identifier, only the path's sha256", () => {
    const repo = hookRepo(true);
    const path = `notes/${SLOTS[0]}.md`;
    const r = commit(repo, path, `${SLOTS[1]}\n`);
    expect(r.status).not.toBe(0);
    expectNoValue(r.out);
    expect(r.out).toContain("rule=private-identifier-2");
    expect(r.out).toContain(`path-sha256=${createHash("sha256").update(path).digest("hex")}`);
  });

  it("never shows a second identifier on the same line", () => {
    const repo = hookRepo(true);
    const r = commit(repo, "notes/pair.txt", `${SLOTS[2]} and ${SLOTS[3]}\n`);
    expect(r.status).not.toBe(0);
    expectNoValue(r.out);
    expect(r.out).toContain("rule=private-identifier-3");
    expect(r.out).toContain("rule=private-identifier-4");
  });

  it("never imports a staged Python module", () => {
    const repo = hookRepo(true);
    const marker = join(temp(), "marker");
    // Shadow modules that, if imported, would record that they ran and print the list.
    const shadow = `import sys\nopen(${JSON.stringify(marker)}, "w").write("ran")\nsys.stderr.write(open(${JSON.stringify(join(repo, ".git/antwars-identifiers"))}).read())\n`;
    for (const name of ["json.py", "hashlib.py", "re.py", "sys.py"]) write(repo, name, shadow);
    write(repo, "notes/hit.txt", `${SLOTS[0]}\n`);
    git(repo, "add", "-A");
    const r = run("git", ["commit", "-q", "-m", "change"], { cwd: repo });
    expect(existsSync(marker)).toBe(false);
    expectNoValue(r.out);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("rule=private-identifier-1");
  });

  it("lets a clean commit through", () => {
    expect(commit(hookRepo(true), "notes/ok.txt", "clean synthetic text\n").status).toBe(0);
  });

  it("builds the rules with origin/main's generator, never the checked-out branch's", () => {
    const repo = hookRepo(true);
    const leak = join(temp(), "leak");
    git(repo, "checkout", "-q", "-b", "untrusted");
    write(repo, ".githooks/identifier-config", leakingGenerator(leak));
    write(repo, ".githooks/pre-commit", "#!/bin/sh\nexit 0\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "--no-verify", "-m", "untrusted");
    const r = commit(repo, "notes/slot.txt", `${SLOTS[0]}\n`);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("private-identifier-1");
    expect(existsSync(leak)).toBe(false);
    expectNoValue(r.out);
  });

  it("will not read the list when it runs from the working tree through core.hooksPath", () => {
    const repo = hookRepo(true);
    const leak = join(temp(), "leak");
    git(repo, "config", "core.hooksPath", ".githooks");
    write(repo, ".githooks/identifier-config", leakingGenerator(leak));
    const r = commit(repo, "notes/ok.txt", "clean\n");
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("will not read");
    expect(existsSync(leak)).toBe(false);
  });

  it("refuses when origin/main has no generator", () => {
    const repo = hookRepo(true);
    git(repo, "update-ref", "-d", "refs/remotes/origin/main");
    const r = commit(repo, "notes/ok.txt", "clean\n");
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("refs/remotes/origin/main has no .githooks/identifier-config");
  });
});

describe.skipIf(!gitleaksDir)("CI identifiers scan (needs gitleaks)", { timeout: 60_000 }, () => {
  /** Runs the base checkout's scan on the candidate, as the workflow does. */
  function scan(repo: string, candidate: string, start: string | undefined, secret: string | null = LIST): Run & { reports: string; work: string } {
    const work = join(temp(), "work");
    const args = [join(repo, ".github/scripts/identifiers-scan.sh"), work, candidate, ...(start ? [start] : [])];
    const r = run("bash", args, { cwd: repo, extraEnv: { ANTWARS_IDENTIFIERS: secret ?? undefined } });
    const reports = existsSync(join(work, "reports")) ? readTree(join(work, "reports")) : "";
    return { ...r, reports, work };
  }
  /** Commits `files` on a candidate branch off the base and returns its head; the checkout stays on main. */
  function candidate(repo: string, ...commits: Record<string, string | null>[]): string {
    git(repo, "checkout", "-q", "-B", "candidate", "main");
    for (const files of commits) {
      for (const [path, text] of Object.entries(files)) {
        if (text === null) git(repo, "rm", "-q", path);
        else {
          write(repo, path, text);
          git(repo, "add", path);
        }
      }
      git(repo, "commit", "-q", "--no-verify", "-m", "candidate");
    }
    const head = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "main");
    return head;
  }

  it("passes a clean candidate and the base itself", () => {
    const { repo, base } = baseRepo();
    const head = candidate(repo, { "src/a.txt": "clean\n" });
    const r = scan(repo, head, base);
    expect(r.out).toContain("1 commits");
    expect(r.status).toBe(0);
    expect(scan(repo, base, undefined).status).toBe(0);
  });

  it.each(SLOTS.map((v, i) => [i + 1, v] as const))("fails on a hit on slot %i, reporting only rule, file and commit", (slot, value) => {
    const { repo, base } = baseRepo();
    const head = candidate(repo, { [`docs/slot-${slot}.md`]: `config: ${value.toUpperCase()}\n` });
    const r = scan(repo, head, base);
    expect(r.status).toBe(1);
    expect(r.reports).toContain(`"RuleID": "private-identifier-${slot}"`);
    expect(r.reports).toContain(head);
    expectNoValue(r.out);
    expectNoValue(r.reports);
  });

  it("deletes the generated identifier config when the scan fails, and when it passes", () => {
    const { repo, base } = baseRepo();
    const failing = scan(repo, candidate(repo, { "docs/a.md": `${SLOTS[0]}\n` }), base);
    expect(failing.status).toBe(1);
    expect(failing.reports).toContain("private-identifier-1");
    expect(existsSync(join(failing.work, "identifiers.toml"))).toBe(false);
    const passing = scan(repo, base, undefined);
    expect(passing.status).toBe(0);
    expect(existsSync(join(passing.work, "identifiers.toml"))).toBe(false);
  });

  it("never shows a path, commit author, email or message, in the scan's output, reports or the Report findings step", () => {
    const { repo, base } = baseRepo();
    // An identifier in a file name, in the commit message and in the author email; the file's
    // content is a hit, so gitleaks reports that file and commit.
    const path = `notes/${SLOTS[0]}.md`;
    git(repo, "checkout", "-q", "-B", "candidate", "main");
    write(repo, path, `${SLOTS[1]}\n`);
    git(repo, "add", path);
    const c = run("git", ["commit", "-q", "--no-verify", "-m", `add ${SLOTS[2]}`], {
      cwd: repo,
      extraEnv: { GIT_AUTHOR_EMAIL: SLOTS[3], GIT_COMMITTER_EMAIL: SLOTS[3] },
    });
    expect(c.status).toBe(0);
    const head = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "main");

    const r = scan(repo, head, base);
    expect(r.status).toBe(1);
    expectNoValue(r.out);
    expectNoValue(r.reports);
    expect(r.reports).toContain(`"RuleID": "private-identifier-2"`);
    expect(r.reports).toContain(head);
    expect(r.reports).toContain(createHash("sha256").update(path).digest("hex"));
    expect(existsSync(join(r.work, "raw"))).toBe(false);

    // The workflow's Report findings step, run on this work directory as CI runs it.
    const yml = readFileSync(join(repo, ".github/workflows/gitleaks.yml"), "utf8").split("\n");
    const start = yml.findIndex((l) => l.includes("name: Report findings"));
    const body = yml.findIndex((l, i) => i > start && l.trim() === "run: |");
    const step: string[] = [];
    for (const l of yml.slice(body + 1)) {
      if (l.trim() !== "" && !l.startsWith("          ")) break;
      step.push(l.slice(10));
    }
    const runnerTemp = dirname(r.work);
    const summary = join(runnerTemp, "summary.md");
    renameSync(r.work, join(runnerTemp, "identifiers"));
    const report = run("python3", ["-c", step.join("\n")], { extraEnv: { RUNNER_TEMP: runnerTemp, GITHUB_STEP_SUMMARY: summary } });
    expect(report.status).toBe(0);
    expect(report.out).toContain("private-identifier-2");
    expect(report.out).toContain(head);
    const md = readFileSync(summary, "utf8");
    expect(md).toContain("private-identifier-2");
    expectNoValue(report.out);
    expectNoValue(md);
  });

  it("fails on a hit that only history carries", () => {
    const { repo, base } = baseRepo();
    const head = candidate(repo, { "docs/a.md": `${SLOTS[2]}\n` }, { "docs/a.md": null });
    const r = scan(repo, head, base);
    expect(r.status).toBe(1);
    expect(r.reports).toContain("private-identifier-3");
    expectNoValue(r.reports);
  });

  it("fails on a hit on the last identifier when the secret has no final LF, as GitHub stores it", () => {
    const { repo, base } = baseRepo();
    const last = SLOTS[SLOTS.length - 1];
    const head = candidate(repo, { "docs/last.md": `${last}\n` });
    const r = scan(repo, head, base, LIST.slice(0, -1));
    expect(r.status).toBe(1);
    expect(r.reports).toContain(`"RuleID": "private-identifier-${SLOTS.length}"`);
    expectNoValue(r.out);
    expectNoValue(r.reports);
  });

  it.each([
    ["missing", null],
    ["empty", ""],
  ])("fails when the secret is %s", (_name, secret) => {
    const { repo, base } = baseRepo();
    const r = scan(repo, candidate(repo, { "src/a.txt": "clean\n" }), base, secret);
    expect(r.status).toBe(1);
    expect(r.out).toContain("ANTWARS_IDENTIFIERS secret is missing or empty");
  });

  it.each([
    ["whitespace-only", " \n\t\n", "the identifier list has no identifiers"],
    ["carrying a CR", "synthetic-one\r\nsynthetic-two", "line 1 contains a CR"],
  ])("fails when the secret is %s", (_name, secret, message) => {
    const { repo, base } = baseRepo();
    const r = scan(repo, candidate(repo, { "src/a.txt": "clean\n" }), base, secret);
    expect(r.status).toBe(1);
    expect(r.out).toContain(message);
    expect(r.out).toContain("not a valid identifier list");
    expect(r.out).not.toContain("synthetic-one");
  });

  it("skips blank lines in the secret and still fails on a hit on every identifier", () => {
    const { repo, base } = baseRepo();
    const head = candidate(repo, { "docs/all.md": SLOTS.map((v) => `${v}\n`).join("") });
    const r = scan(repo, head, base, "\n" + SLOTS.join("\n\n") + "\n\n");
    expect(r.status).toBe(1);
    for (let slot = 1; slot <= SLOTS.length; slot++) expect(r.reports).toContain(`"RuleID": "private-identifier-${slot}"`);
    expectNoValue(r.out);
    expectNoValue(r.reports);
  });

  it("uses the base's defaults config when the candidate widens the allowlist and its pin to hide a key", () => {
    const { repo, base } = baseRepo();
    const widened = readFileSync(join(repo, ".gitleaks-defaults.toml"), "utf8") +
      `\n[[allowlists]]\ndescription = "everything"\npaths = ['''.*''']\n`;
    write(repo, ".gitleaks-defaults.toml", widened);
    const pin = git(repo, "hash-object", ".gitleaks-defaults.toml");
    git(repo, "checkout", "-q", "--", ".gitleaks-defaults.toml");
    const hook = readFileSync(join(repo, ".githooks/pre-commit"), "utf8").replace(/^defaults_baseline=[0-9a-f]{40}$/m, `defaults_baseline=${pin}`);
    const head = candidate(repo, { ".gitleaks-defaults.toml": widened, ".githooks/pre-commit": hook, "src/key.txt": `${syntheticToken()}\n` });
    const r = scan(repo, head, base);
    expect(r.status).toBe(1);
    expect(r.reports).toContain(`"RuleID": "github-pat"`);
    expect(r.out).toContain("::notice title=identifiers::This change modifies .gitleaks-defaults.toml.");
    expect(r.out).toContain("::notice title=identifiers::This change modifies .githooks/pre-commit.");
    expect(r.out).not.toContain("does not match the defaults_baseline line");
  });

  it("never runs or loads the candidate's scan script or generator", () => {
    const { repo, base } = baseRepo();
    const head = candidate(repo, {
      ".github/scripts/identifiers-scan.sh": "#!/usr/bin/env bash\necho CANDIDATE-SCRIPT-RAN\nexit 0\n",
      ".githooks/identifier-config": "#!/bin/sh\necho CANDIDATE-GENERATOR-RAN >&2\necho 'title = \"none\"'\n",
      ".github/workflows/gitleaks.yml": "name: gitleaks\n",
      "docs/a.md": `${SLOTS[0]}\n`,
    });
    const r = scan(repo, head, base);
    expect(r.status).toBe(1);
    expect(r.out).not.toContain("CANDIDATE-");
    expect(r.reports).toContain("private-identifier-1");
    for (const f of [".github/scripts/identifiers-scan.sh", ".githooks/identifier-config", ".github/workflows/gitleaks.yml"]) {
      expect(r.out).toContain(`This change modifies ${f}.`);
    }
  });

  it("fails a candidate whose defaults config no longer matches its own pin", () => {
    const { repo, base } = baseRepo();
    const changed = readFileSync(join(repo, ".gitleaks-defaults.toml"), "utf8") + "\n# edited\n";
    const r = scan(repo, candidate(repo, { ".gitleaks-defaults.toml": changed }), base);
    expect(r.status).toBe(1);
    expect(r.out).toContain("does not match the defaults_baseline line");
  });

  it("is not suppressed by a .gitleaksignore in the candidate", () => {
    const { repo, base } = baseRepo();
    const first = candidate(repo, { "docs/a.md": `${SLOTS[1]}\n` });
    git(repo, "checkout", "-q", "candidate");
    write(repo, ".gitleaksignore", `${first}:docs/a.md:private-identifier-2:1\ndocs/a.md:private-identifier-2:1\n`);
    git(repo, "add", ".gitleaksignore");
    git(repo, "commit", "-q", "--no-verify", "-m", "ignore");
    const head = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "main");
    const r = scan(repo, head, base);
    expect(r.status).toBe(1);
    expect(r.reports).toContain("private-identifier-2");
  });

  it("writes a candidate symlink as its target text, never following it", () => {
    const { repo, base } = baseRepo();
    const outside = join(temp(), "outside.txt");
    writeFileSync(outside, `${SLOTS[3]}\n`);
    git(repo, "checkout", "-q", "-B", "candidate", "main");
    symlinkSync(outside, join(repo, "link"));
    git(repo, "add", "link");
    git(repo, "commit", "-q", "--no-verify", "-m", "link");
    const head = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "main");
    const work = join(temp(), "work");
    const r = run("bash", [join(repo, ".github/scripts/identifiers-scan.sh"), work, head, base], { cwd: repo, extraEnv: { ANTWARS_IDENTIFIERS: LIST } });
    expect(r.status).toBe(0);
    expect(lstatSync(join(work, "candidate/link")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(work, "candidate/link"), "utf8")).toBe(outside);
  });
});
