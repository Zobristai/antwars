// Runs the README's install line itself, byte for byte, so the documented line is
// the tested one: in a git worktree with no setting, and from a fresh public
// checkout into an empty non-git folder through ANTWARS_SEAT_STORE. No
// internal path is used or substituted anywhere.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const README = readFileSync(join(PACKAGE, "README.md"), "utf8");
const INSTALL = README.split("\n").find((line) => line.startsWith("G=${ANTWARS_SEAT_STORE:-"));
const root = mkdtempSync(join(tmpdir(), "antwars-seat-install-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The test's own environment without git or seat settings, so only what a case sets applies. */
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_") && !name.startsWith("ANTWARS_")));
const sh = (cwd, line, env = {}) => spawnSync("bash", ["-c", line], { cwd, env: { ...cleanEnv, ...env } });

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, stdio: "pipe", env: cleanEnv }).toString();

/** A repository whose main carries this package, like the published antwar repository. */
function makeOrigin() {
  const repo = join(root, "origin");
  mkdirSync(join(repo, "packages"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  cpSync(PACKAGE, join(repo, "packages", "antwars-seat"), { recursive: true, filter: (src) => !src.includes("/.antwars-seat") && !src.includes("node_modules") });
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seat harness");
  git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  return repo;
}

const bin = (dir) => join(dir, ".antwars-seat", "bin", "antwars-seat");
const seat = (dir, args, env = {}) => spawnSync(bin(dir), args, { cwd: dir, env: { ...cleanEnv, ...env } });

/** Every file under dir, recursively. */
const files = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));

const SETUP = ["setup", "--handle", "antwars/t", "--key-name", "ANTWARS_HOUSE_T", "--mode", "house-1v1", "--model-label", "m", "--thinking-level", "high"];

describe("README install line", () => {
  const origin = makeOrigin();

  it("is present, reads origin/main and names no fixed store path", () => {
    expect(INSTALL).toBeDefined();
    expect(INSTALL).toContain("archive origin/main:packages/antwars-seat");
    expect(INSTALL).toContain("ANTWARS_SEAT_STORE");
    expect(INSTALL).not.toMatch(/\/\.git\b/);
  });

  it("installs into a local git worktree with no setting", () => {
    const worktree = join(root, "worktree");
    git(origin, "worktree", "add", "-q", "--detach", worktree);
    const run = sh(worktree, INSTALL);
    expect(run.status, run.stderr.toString()).toBe(0);
    expect(seat(worktree, ["help"]).stdout.toString()).toContain("antwars-seat — Antwars seat harness");
  });

  it("installs from a fresh public checkout into an empty non-git folder through ANTWARS_SEAT_STORE, and finds the key there", () => {
    const checkout = join(root, "public");
    execFileSync("git", ["clone", "-q", origin, checkout], { stdio: "pipe", env: cleanEnv });
    const store = join(checkout, ".git");
    const empty = join(root, "empty");
    mkdirSync(empty);

    const run = sh(empty, INSTALL, { ANTWARS_SEAT_STORE: store });
    expect(run.status, run.stderr.toString()).toBe(0);
    expect(existsSync(join(empty, ".git"))).toBe(false);
    expect(seat(empty, ["help"]).stdout.toString()).toContain("ANTWARS_SEAT_STORE");
    for (const file of files(join(empty, ".antwars-seat", "lib")).concat(files(join(empty, ".antwars-seat", "bin")))) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/\/\.git\b/);
    }

    const missing = seat(empty, SETUP);
    expect(missing.status).toBe(1);
    expect(missing.stderr.toString() + missing.stdout.toString()).toContain("ANTWARS_SEAT_STORE");

    writeFileSync(join(store, "antwars-house-keys.env"), `ANTWARS_HOUSE_T=${JSON.stringify("sk-antwars-install-test")}\n`);
    const setup = seat(empty, SETUP, { ANTWARS_SEAT_STORE: store });
    expect(setup.status, setup.stderr.toString()).toBe(0);
    expect(existsSync(join(empty, ".antwars-seat", "state", "config.json"))).toBe(true);
  });

  it("stops in an empty non-git folder with no setting, naming ANTWARS_SEAT_STORE", () => {
    const bare = join(root, "bare");
    mkdirSync(bare);
    const run = sh(bare, INSTALL);
    expect(run.status).not.toBe(0);
    expect(run.stderr.toString()).toContain("set ANTWARS_SEAT_STORE to the .git directory of an antwar checkout");
    expect(existsSync(join(bare, ".antwars-seat"))).toBe(false);
  });
});
