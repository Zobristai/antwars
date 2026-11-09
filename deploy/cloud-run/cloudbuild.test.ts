import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// cloudbuild-run.sh, copied beside config.sh and a fake deploy.sh into a scratch
// checkout, against fake git, curl, gcloud and npm on PATH: its own shell logic runs,
// and every external call is recorded instead of made.
const here = resolve("deploy/cloud-run");
const SHA = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const BUILD_ID = "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b";
// Made-up settings, one per name in config.sh's DEPLOY_SETTINGS.
const CONFIG: Record<string, string> = {
  ACCOUNT: "deployer@example-project.iam.gserviceaccount.com",
  PROJECT: "example-project",
  BUILD_BUCKET: "example-build",
  BUILD_SA: "builder@example-project.iam.gserviceaccount.com",
  RUN_SA: "runner@example-project.iam.gserviceaccount.com",
  RECORDS_SA: "records@example-project.iam.gserviceaccount.com",
  RECORD_INPUT_BUCKET: "example-record-inputs",
  REPLAY_BUCKET: "example-replays",
  GAME_SERVICE_URL: "https://game.example.com",
};
const scratch: string[] = [];
afterEach(() => { for (const p of scratch.splice(0)) rmSync(p, { recursive: true, force: true }); });

interface Options {
  /** _ARGS (a build started without a tag). */
  readonly args?: string;
  /** TAG_NAME (a build started by a pushed tag). */
  readonly tag?: string;
  /** COMMIT_SHA, the build's checked-out commit (default SHA). */
  readonly commit?: string;
  /** The identity the fake metadata server reports (default the config's ACCOUNT); null answers nothing. */
  readonly identity?: string | null;
  /** merge-base --is-ancestor HEAD origin/main succeeds (default true). */
  readonly onMain?: boolean;
  /** The fake deploy.sh's exit status (default 0). */
  readonly deployRc?: number;
  /** The fake deploy.sh writes its status and a records rollback spec (default true). */
  readonly writes?: boolean;
  /** gcloud storage cp fails. */
  readonly uploadFails?: boolean;
  /** Replaces settings; an empty string sends the substitution empty. */
  readonly config?: Record<string, string>;
}

function setup(options: Options) {
  const dir = mkdtempSync(join(tmpdir(), "antwar-cloudbuild-test-"));
  scratch.push(dir);
  const root = join(dir, "checkout");
  const tools = join(root, "deploy", "cloud-run");
  const bin = join(dir, "bin");
  mkdirSync(tools, { recursive: true });
  mkdirSync(bin);
  copyFileSync(join(here, "cloudbuild-run.sh"), join(tools, "cloudbuild-run.sh"));
  copyFileSync(join(here, "config.sh"), join(tools, "config.sh"));
  const calls = join(dir, "calls.jsonl");
  writeFileSync(calls, "");
  const record = (name: string) => `fs.appendFileSync(process.env.CALLS, JSON.stringify(["${name}", ...process.argv.slice(2)]) + "\\n");`;
  const fake = (path: string, name: string, body: string) => writeFileSync(path, `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
${record(name)}
${body}
`, { mode: 0o755 });
  fake(join(bin, "git"), "git", `
const rest = a[0] === "-C" ? a.slice(2) : a;
if (rest[0] === "rev-parse" && rest[1] === "--show-toplevel") console.log(process.env.ROOT);
else if (rest[0] === "rev-parse") console.log("${"c".repeat(40)}");
else if (rest[0] === "merge-base") process.exit(process.env.ON_MAIN === "1" ? 0 : 1);
`);
  fake(join(bin, "curl"), "curl", `
if (process.env.IDENTITY === "") process.exit(22);
process.stdout.write(process.env.IDENTITY);
`);
  fake(join(bin, "gcloud"), "gcloud", `if (process.env.UPLOAD_FAILS === "1") process.exit(1);`);
  fake(join(bin, "npm"), "npm", "");
  // deploy.sh: records its arguments, the config it was given and where its outputs go;
  // writes them there; passes TERM on as deploy.sh's own handler does (FAILED, exit 143).
  fake(join(tools, "deploy.sh"), "deploy.sh", `
const out = process.env.ANTWAR_ROLLBACK_DIR;
fs.appendFileSync(process.env.CALLS, JSON.stringify(["deploy.sh config", fs.readFileSync(process.env.ANTWAR_DEPLOY_CONFIG, "utf8"), out]) + "\\n");
const write = (status) => { if (process.env.WRITES === "1") { fs.writeFileSync(out + "/antwar-deploy-status", status + "\\n"); fs.writeFileSync(out + "/records-rollback-r1.json", "{}"); } };
process.on("SIGTERM", () => { write("FAILED"); process.exit(143); });
if (process.env.HANG === "1") { fs.writeFileSync(process.env.STARTED, ""); setInterval(() => {}, 1000); }
else { write(Number(process.env.DEPLOY_RC) === 0 ? "DONE" : "FAILED"); process.exit(Number(process.env.DEPLOY_RC)); }
`);
  const settings = { ...CONFIG, ...options.config };
  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH}`,
    CALLS: calls,
    ROOT: root,
    STARTED: join(dir, "started"),
    IDENTITY: options.identity === null ? "" : (options.identity ?? CONFIG.ACCOUNT),
    ON_MAIN: options.onMain === false ? "0" : "1",
    DEPLOY_RC: String(options.deployRc ?? 0),
    WRITES: options.writes === false ? "0" : "1",
    UPLOAD_FAILS: options.uploadFails ? "1" : "0",
    ANTWAR_ARGS: options.args ?? "",
    ANTWAR_TAG: options.tag ?? "",
    ANTWAR_COMMIT: options.commit ?? SHA,
    ANTWAR_BUILD_ID: BUILD_ID,
    ...Object.fromEntries(Object.entries(settings).map(([k, v]) => [`ANTWAR_CFG_${k}`, v])),
  };
  const script = join(tools, "cloudbuild-run.sh");
  const callList = () => readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
  return { env, script, tools, callList, started: env.STARTED };
}

function run(options: Options) {
  const s = setup(options);
  const r = spawnSync("bash", [s.script], { env: s.env, encoding: "utf8" });
  return { status: r.status, stderr: r.stderr, stdout: r.stdout, calls: s.callList(), tools: s.tools };
}
const deployCall = (calls: string[][]) => calls.find((c) => c[0] === "deploy.sh");
const configCall = (calls: string[][]) => calls.find((c) => c[0] === "deploy.sh config")!;
const uploads = (calls: string[][]) => calls.filter((c) => c[0] === "gcloud" && c[1] === "storage" && c[2] === "cp");

describe("cloudbuild-run.sh", () => {
  it.each([
    "slots live " + SHA,
    "slots preview " + SHA,
    "records " + SHA,
    "preview " + SHA + " name",
    SHA,
    "all",
    "all " + SHA.slice(0, 39),
    "all " + SHA + " --force",
    "all " + SHA + " --precheck extra",
    "records-rollback " + SHA,
    "records-rollback " + SHA + " sha256:short",
    "",
  ])("refuses _ARGS %j before any call", (args) => {
    const r = run({ args });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("refusing: _ARGS must be");
    expect(r.calls).toEqual([]);
  });

  it("refuses a build whose commit is not a full sha, before any call", () => {
    for (const commit of ["", SHA.slice(0, 7)]) {
      const r = run({ args: `all ${SHA}`, commit });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("(COMMIT_SHA) is not a full 40-hex sha");
      expect(r.calls).toEqual([]);
    }
  });

  it("runs a deploy-<sha> tag on that commit as `all <sha>`", () => {
    const r = run({ tag: `deploy-${SHA}` });
    expect(r.status).toBe(0);
    expect(deployCall(r.calls)).toEqual(["deploy.sh", "all", SHA]);
    expect(r.calls.some((c) => c[0] === "npm")).toBe(true);
    expect(uploads(r.calls)).toHaveLength(1);
  });

  it.each([
    [`deploy-${"b".repeat(40)}`, "is on commit"],
    [`deploy-${SHA.slice(0, 39)}`, "is not deploy-<full 40-hex sha>"],
    [`deploy-${SHA}-again`, "is not deploy-<full 40-hex sha>"],
    [`v${SHA}`, "is not deploy-<full 40-hex sha>"],
    [`deploy-${SHA.toUpperCase()}`, "is not deploy-<full 40-hex sha>"],
  ])("refuses tag %s before any call", (tag, why) => {
    const r = run({ tag });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(why);
    expect(r.calls).toEqual([]);
  });

  it("refuses _ARGS on a tag build, so a tag only ever runs `all`", () => {
    const r = run({ tag: `deploy-${SHA}`, args: `all ${SHA} --precheck` });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("a tag build takes no _ARGS");
    expect(r.calls).toEqual([]);
  });

  it("deploys nothing for a tag on a commit not on origin/main", () => {
    const r = run({ tag: `deploy-${SHA}`, onMain: false });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("is not on origin/main");
    expect(r.calls.some((c) => ["curl", "gcloud", "deploy.sh"].includes(c[0]))).toBe(false);
  });

  it("refuses to run as any identity but the config's ACCOUNT, before gcloud or deploy.sh", () => {
    for (const identity of ["someone-else@example-project.iam.gserviceaccount.com", null]) {
      const r = run({ args: `all ${SHA}`, identity });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("not the config's ACCOUNT");
      expect(r.calls.some((c) => c[0] === "gcloud" || c[0] === "deploy.sh" || c[0] === "npm")).toBe(false);
    }
  });

  it("asks the metadata server for the build's own identity", () => {
    const r = run({ args: `all ${SHA} --precheck` });
    expect(r.calls.find((c) => c[0] === "curl")).toEqual(["curl", "-sf", "--max-time", "10", "-H", "Metadata-Flavor: Google",
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email"]);
  });

  it("refuses deploy tooling from a commit not on origin/main", () => {
    const r = run({ args: `all ${SHA}`, onMain: false });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("is not on origin/main");
    expect(r.calls.some((c) => ["curl", "gcloud", "deploy.sh"].includes(c[0]))).toBe(false);
  });

  it("refuses an empty setting, naming it, before any call", () => {
    const r = run({ args: `all ${SHA}`, config: { RUN_SA: "" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/lacks RUN_SA/);
    expect(r.calls).toEqual([]);
  });

  it("refuses a setting holding a line break, which could add a setting of its own", () => {
    const r = run({ args: `all ${SHA}`, config: { REPLAY_BUCKET: "example-replays\nACCOUNT=other" } });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("_REPLAY_BUCKET holds a line break");
    expect(r.calls).toEqual([]);
  });

  it("runs `all <sha>` with the config written from the settings and saves its outputs", () => {
    const r = run({ args: `all ${SHA}` });
    expect(r.status).toBe(0);
    const [, written, out] = configCall(r.calls);
    expect(written).toBe(Object.entries(CONFIG).map(([k, v]) => `${k}=${v}\n`).join(""));
    expect(deployCall(r.calls)).toEqual(["deploy.sh", "all", SHA]);
    expect(r.calls.find((c) => c[0] === "npm")).toEqual(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
    const [up] = uploads(r.calls);
    expect(up).toEqual(["gcloud", "storage", "cp", `${out}/antwar-deploy-status`, `${out}/records-rollback-r1.json`,
      `gs://example-build/deploys/${BUILD_ID}/`, "--account", CONFIG.ACCOUNT, "--project", CONFIG.PROJECT]);
    expect(r.stderr).toContain("==================== deploy status ====================\nDONE");
  });

  it("runs the precheck and records-rollback without packages", () => {
    for (const args of [`all ${SHA} --precheck`, `records-rollback ${SHA} ${DIGEST}`]) {
      const r = run({ args, writes: false });
      expect(r.status).toBe(0);
      expect(deployCall(r.calls)).toEqual(["deploy.sh", ...args.split(" ")]);
      expect(r.calls.some((c) => c[0] === "npm")).toBe(false);
      // Nothing written, nothing saved.
      expect(uploads(r.calls)).toEqual([]);
    }
  });

  it("keeps deploy.sh's failing exit status, and still saves its outputs", () => {
    const r = run({ args: `all ${SHA}`, deployRc: 1 });
    expect(r.status).toBe(1);
    expect(uploads(r.calls)).toHaveLength(1);
    expect(r.stderr).toContain("FAILED");
  });

  it("fails a successful run whose outputs could not be saved", () => {
    const r = run({ args: `all ${SHA}`, uploadFails: true });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`could not save the deploy outputs to gs://example-build/deploys/${BUILD_ID}/`);
    expect(r.stderr).toContain("DONE");
  });

  it("passes TERM on to deploy.sh, then saves the FAILED status it leaves", async () => {
    const s = setup({ args: `all ${SHA}` });
    const child = spawn("bash", [s.script], { env: { ...s.env, HANG: "1" } });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    for (let i = 0; i < 200 && !existsSync(s.started); i++) await new Promise((r) => setTimeout(r, 25));
    child.kill("SIGTERM");
    const status = await new Promise<number | null>((r) => child.on("close", (code) => r(code)));
    expect(status).toBe(143);
    expect(uploads(s.callList())).toHaveLength(1);
    expect(stderr).toContain("FAILED");
  });
});

describe("cloudbuild.yaml", () => {
  const yaml = readFileSync(join(here, "cloudbuild.yaml"), "utf8");
  const config = readFileSync(join(here, "config.sh"), "utf8");
  const settings = /DEPLOY_SETTINGS=\(([^)]*)\)/.exec(config)![1].split(/\s+/).filter(Boolean);

  it("takes the tag and commit from the trigger's built-in substitutions", () => {
    expect(yaml).toContain("- ANTWAR_TAG=$TAG_NAME\n");
    expect(yaml).toContain("- ANTWAR_COMMIT=$COMMIT_SHA\n");
    expect(yaml).toContain("- ANTWAR_ARGS=$_ARGS\n");
  });

  it("passes every config setting from a substitution, the project from the build's own", () => {
    for (const name of settings) {
      expect(yaml).toContain(`- ANTWAR_CFG_${name}=$${name === "PROJECT" ? "PROJECT_ID" : `_${name}`}\n`);
    }
  });

  it("gives no setting a default: only the public repository address and an empty _ARGS", () => {
    const block = /\nsubstitutions:\n((?: {2}.*\n)*)/.exec(yaml)![1];
    expect(block).toBe("  _REPO_URL: https://github.com/Zobristai/antwars.git\n  _ARGS: ''\n");
  });

  it("escapes every shell $ in the step's script, so Cloud Build substitutes none of it", () => {
    const script = /\n {6}- \|\n((?: {8}.*\n)*)/.exec(yaml)![1];
    expect(script).toContain('git -C /tmp/antwars checkout --quiet --detach "$$ANTWAR_COMMIT"');
    expect(script).toContain("exec bash /tmp/antwars/deploy/cloud-run/cloudbuild-run.sh");
    expect(script.replaceAll("$$", "")).not.toContain("$");
  });

  it("logs to Cloud Logging, and outlasts deploy.sh's longest run", () => {
    expect(yaml).toMatch(/\noptions:\n {2}logging: CLOUD_LOGGING_ONLY\n/);
    expect(yaml).toMatch(/\ntimeout: 43200s\n/);
  });
});
