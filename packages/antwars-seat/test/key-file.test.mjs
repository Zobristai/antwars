// Where the seat client looks for the house key file.
// Committed first as a characterization of the old fallback; the cases that reached
// a fixed default store path now expect the error. Paths are only resolved here; no real
// key file is ever read.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { NO_KEY_FILE, keyFilePath, readKey } from "../lib/state.mjs";

const root = realpathSync(mkdtempSync(join(tmpdir(), "antwars-seat-key-file-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, stdio: "pipe", env: cleanEnv });

/** A git repo with one commit, so a linked worktree can be added to it. */
function makeRepo(name) {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  return repo;
}

describe("keyFilePath", () => {
  it("uses ANTWARS_KEY_FILE when set, wherever it runs", () => {
    const empty = join(root, "explicit");
    mkdirSync(empty);
    expect(keyFilePath({ ANTWARS_KEY_FILE: "/keys/house.env" }, empty)).toBe("/keys/house.env");
  });

  it("uses the key file in the git common dir when it exists, from the checkout and from a linked worktree", () => {
    const repo = makeRepo("with-key");
    writeFileSync(join(repo, ".git", "antwars-house-keys.env"), "X=\"y\"\n");
    const worktree = join(root, "with-key-worktree");
    git(repo, "worktree", "add", "-q", "--detach", worktree);
    expect(keyFilePath({}, repo)).toBe(join(repo, ".git", "antwars-house-keys.env"));
    expect(keyFilePath({}, worktree)).toBe(join(repo, ".git", "antwars-house-keys.env"));
  });

  it("uses ANTWARS_SEAT_STORE's key file when set, over the git common dir copy; ANTWARS_KEY_FILE still wins", () => {
    const repo = makeRepo("store-over-local");
    writeFileSync(join(repo, ".git", "antwars-house-keys.env"), "X=\"y\"\n");
    expect(keyFilePath({ ANTWARS_SEAT_STORE: "/stores/antwar/.git" }, repo)).toBe("/stores/antwar/.git/antwars-house-keys.env");
    expect(keyFilePath({ ANTWARS_SEAT_STORE: "/stores/antwar/.git", ANTWARS_KEY_FILE: "/keys/house.env" }, repo)).toBe("/keys/house.env");
  });

  // These two fell back to a fixed default store path before.
  it("stops with an error naming both settings in a git checkout without the key file", () => {
    const repo = makeRepo("without-key");
    expect(() => keyFilePath({}, repo)).toThrow(NO_KEY_FILE);
  });

  it("stops with an error naming both settings in an empty non-git folder", () => {
    const empty = join(root, "empty");
    mkdirSync(empty);
    expect(() => keyFilePath({}, empty)).toThrow(NO_KEY_FILE);
    expect(NO_KEY_FILE).toContain("ANTWARS_KEY_FILE");
    expect(NO_KEY_FILE).toContain("ANTWARS_SEAT_STORE");
    expect(NO_KEY_FILE).not.toMatch(/\/\.git\b/);
  });
});

describe("readKey", () => {
  it("passes the missing-setting error through", () => {
    const empty = join(root, "empty-read");
    mkdirSync(empty);
    expect(() => readKey("ANY", {}, empty)).toThrow(NO_KEY_FILE);
  });

  it("names the resolved file when it cannot be read", () => {
    const missing = join(root, "missing.env");
    expect(() => readKey("ANY", { ANTWARS_KEY_FILE: missing }, root)).toThrow(`House key file not readable: ${missing}`);
  });
});
