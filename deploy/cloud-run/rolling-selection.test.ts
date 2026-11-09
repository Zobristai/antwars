import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runningBuildName } from "../../src/records/input-store.ts";

// How `deploy.sh all` chooses between the rolling deploy and the full gate when the
// deploy checkout is a single parentless commit, so the support commits and the outgoing
// commits' ancestry are absent. Each run goes as far as the first action that differs by mode,
// then stops there because the fake fails the record service's `run deploy`:
//   rolling   - running/<commit> written, then the records overlap tag, and no queue or lobby read;
//   full gate - the queue and lobby reads, and no running/<commit> write or records overlap tag.
const script = resolve("deploy/cloud-run/deploy.sh");
const CONFIG = {
  ACCOUNT: "operator@example.com",
  PROJECT: "example-project",
  BUILD_BUCKET: "example-build",
  BUILD_SA: "antwar-build@example-project.iam.gserviceaccount.com",
  RUN_SA: "antwar-run@example-project.iam.gserviceaccount.com",
  RECORDS_SA: "antwar-records@example-project.iam.gserviceaccount.com",
  RECORD_INPUT_BUCKET: "example-record-inputs",
  REPLAY_BUCKET: "example-replays",
  GAME_SERVICE_URL: "https://antwar-123456789.australia-southeast1.run.app",
};
const HOST = "australia-southeast1-docker.pkg.dev";
const REPO = `${HOST}/example-project/antwar/server`;
const REGISTRY = `https://${HOST}/v2/example-project/antwar/server`;
const FS = "https://firestore.googleapis.com/v1/projects/example-project/databases/(default)/documents/namespaces/live";
// Deploy.sh writes running/<commit> by exact name with one JSON-API media upload to the record input bucket.
const UPLOAD = "https://storage.googleapis.com/upload/storage/v1/b/example-record-inputs/o?uploadType=media&name=";
const KEY = "ai.antwars.rolling-support";
const SUPPORT = "46d6c91bcaf385019fc8477646047c85a3263804 e6f22591cd2a40ddcccb084b2c11f49745e12398";
const FIRST_SUPPORT = SUPPORT.split(" ")[0]!;
const SHA = "a".repeat(40);
const TIMEOUT = 180_000;

const SLOTS = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => `public-${n}`).concat([0, 1, 2, 3, 4, 5, 6, 7].map((n) => `private-${n}`));
const SERVICES = ["antwar-records", ...SLOTS.map((s) => `antwar-${s}`), "antwar"];
const RECORDS = "antwar-records", SLOT = "antwar-public-3", GAME = "antwar";
const digest = (c: string) => `sha256:${c.repeat(64)}`;
// The outgoing builds. The records commit differs from the incoming one, so a rolling run
// declares the overlap and tags the outgoing records revision.
const OUT_SHA: Record<string, string> = Object.fromEntries(SERVICES.map((s) => [s, s === RECORDS ? "d".repeat(40) : s === GAME ? "6".repeat(40) : "9".repeat(40)]));
OUT_SHA[SLOT] = "7".repeat(40);
const OUT_DIGEST: Record<string, string> = Object.fromEntries(SERVICES.map((s) => [s, digest(s === RECORDS ? "1" : s === GAME ? "3" : "2")]));
OUT_DIGEST[SLOT] = digest("4");
const outRev = (svc: string) => `${svc}-00009-old`;
const manifestUrl = (d: string) => `${REGISTRY}/manifests/${d}`;
const configDigest = (d: string) => `sha256:0${d.slice(8)}`;
const blobUrl = (d: string) => `${REGISTRY}/blobs/${configDigest(d)}`;

interface Answer { status: number; location?: string; body?: string }
interface State {
  services: Record<string, { latest: string; traffic: { revisionName: string; percent?: number; tag?: string }[] }>;
  revisions: Record<string, { image: string; sha: string }>;
  registry: Record<string, Answer>;
}
interface Request { url: string; auth: string; args: string[] }

const manifest = (d: string) => JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", config: { digest: configDigest(d) }, layers: [] });
const config = (labels: Record<string, string>) => JSON.stringify({ architecture: "amd64", os: "linux", config: { Cmd: ["npm", "start"], Labels: labels } });
const index = (...entries: [arch: string, digest: string][]) => JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json",
  manifests: entries.map(([architecture, d]) => ({ digest: d, platform: { os: "linux", architecture } })) });
// Image d at the server repository, its config carrying labels.
const image = (d: string, labels: Record<string, string> = { [KEY]: "1" }): Record<string, Answer> => ({
  [manifestUrl(d)]: { status: 200, body: manifest(d) },
  [blobUrl(d)]: { status: 200, body: config(labels) },
});

// The control fixture, which rolls: every outgoing service serves one revision of a labelled
// image at the server repository, and the checkout shows none of their ancestry.
function control(): State {
  const state: State = { services: {}, revisions: {}, registry: {} };
  for (const svc of SERVICES) {
    state.services[svc] = { latest: outRev(svc), traffic: [{ revisionName: outRev(svc), percent: 100 }] };
    state.revisions[outRev(svc)] = { image: `${REPO}@${OUT_DIGEST[svc]}`, sha: OUT_SHA[svc]! };
    Object.assign(state.registry, image(OUT_DIGEST[svc]!));
  }
  return state;
}

function setup(state: State, env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "antwar-rolling-selection-"));
  const calls = join(dir, "calls.jsonl"), requests = join(dir, "requests.jsonl"), statePath = join(dir, "state.json");
  writeFileSync(calls, "");
  writeFileSync(requests, "");
  writeFileSync(statePath, JSON.stringify(state));
  const fake = (name: string, body: string) => writeFileSync(join(dir, name), `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify(["${name}", ...a]) + "\\n");
${body}
`, { mode: 0o755 });
  // A parentless checkout: no outgoing commit's ancestry, so every support check exits 128 unless
  // SUPPORTED names the outgoing commit; the incoming commit is on origin/main.
  fake("git", `
const rest = a[0] === "-C" ? a.slice(2) : a;
if (rest[0] === "rev-parse") console.log(process.env.ROOT);
else if (rest[0] === "merge-base" && rest[3] === "origin/main") process.exit(0);
else if (rest[0] === "merge-base") process.exit((process.env.SUPPORTED ?? "").split(" ").includes(rest[3]) ? 0 : 128);
else if (rest[0] === "archive") fs.writeFileSync(rest[rest.indexOf("-o") + 1], "");
`);
  fake("gcloud", `
const at = (...w) => w.every((x, i) => a[i] === x);
const st = JSON.parse(fs.readFileSync(process.env.STATE, "utf8"));
const save = () => fs.writeFileSync(process.env.STATE, JSON.stringify(st));
const flag = (f) => { const i = a.indexOf(f); return i < 0 ? undefined : a[i + 1]; };
if (at("auth", "print-access-token")) { if (process.env.FAKE_NO_TOKEN === "1") process.exit(1); console.log("fake-token"); }
else if (at("projects", "describe")) console.log("123456789");
// The antwars.ai forwarding rules deploy.sh reads before it deploys (RFC 5737 address).
else if (at("compute", "forwarding-rules", "list")) console.log(JSON.stringify([{ name: "antwar-domain-https", IPAddress: "192.0.2.10" }]));
else if (at("run", "services", "describe") && st.services[a[3]]) {
  const svc = st.services[a[3]];
  console.log(JSON.stringify({ status: { latestReadyRevisionName: svc.latest, latestCreatedRevisionName: svc.latest, traffic: svc.traffic } }));
}
else if (at("run", "revisions", "describe") && st.revisions[a[3]]) {
  const rev = st.revisions[a[3]];
  console.log(JSON.stringify({ metadata: { name: a[3] }, status: { imageDigest: rev.image, conditions: [{ type: "Ready", status: "True" }] },
    spec: { containers: [{ image: rev.image, env: [{ name: "ANTWAR_CODE_VERSION", value: rev.sha }] }] } }));
}
else if (at("artifacts", "docker", "images", "describe")) { if (process.env.IMAGE_EXISTS === "1" || fs.existsSync(process.env.BUILT)) console.log(process.env.FAKE_DIGEST); else process.exit(1); }
else if (at("builds", "submit")) fs.writeFileSync(process.env.BUILT, "");
else if (at("run", "deploy") && st.services[a[2]]) {
  if (process.env.FAIL_DEPLOY === a[2]) process.exit(1);
  const svc = st.services[a[2]];
  svc.latest = a[2] + "-new";
  st.revisions[svc.latest] = { image: flag("--image"), sha: (flag("--set-env-vars") ?? flag("--update-env-vars") ?? "").match(/ANTWAR_CODE_VERSION=([0-9a-f]+)/)[1] };
  svc.traffic = [{ revisionName: svc.latest, percent: 100 }, ...svc.traffic.filter((t) => t.tag).map((t) => ({ revisionName: t.revisionName, tag: t.tag }))];
  save();
}
else if (at("run", "services", "update-traffic") && st.services[a[3]]) {
  const svc = st.services[a[3]];
  if (a.includes("--to-latest")) svc.traffic = [{ revisionName: svc.latest, percent: 100 }, ...svc.traffic.filter((t) => t.tag).map((t) => ({ revisionName: t.revisionName, tag: t.tag }))];
  if (a.includes("--clear-tags")) svc.traffic = svc.traffic.filter((t) => t.percent).map((t) => ({ revisionName: t.revisionName, percent: t.percent }));
  const set = flag("--set-tags");
  if (set) svc.traffic = [...svc.traffic, ...set.split(",").map((kv) => ({ revisionName: kv.split("=")[1], tag: kv.split("=")[0] }))];
  save();
}
else if (at("storage", "cp", "-")) fs.readFileSync(0);
else process.exit(1);
`);
  // Firestore and the registry. Every request is recorded with the header it received on stdin.
  fake("curl", `
const url = a.at(-1);
const auth = a.includes("@-") ? fs.readFileSync(0, "utf8") : "";
fs.appendFileSync(process.env.REQUESTS, JSON.stringify({ url, auth, args: a }) + "\\n");
const st = JSON.parse(fs.readFileSync(process.env.STATE, "utf8"));
let answer = { status: 404, body: "" };
if (url.startsWith(${JSON.stringify(FS)})) {
  if (auth !== "Authorization: Bearer fake-token\\n") answer = { status: 401, body: "{}" };
  else answer = { status: 200, body: JSON.stringify({ documents: [] }) };
}
// The running/<commit> upload succeeds only with the token on stdin.
else if (url.startsWith(${JSON.stringify(UPLOAD)})) answer = { status: auth === "Authorization: Bearer fake-token\\n" ? 200 : 401, body: "" };
else if (st.registry[url]) answer = st.registry[url];
// The registry refuses its own host's requests without the token.
if (new URL(url).host === ${JSON.stringify(HOST)} && auth !== "Authorization: Bearer fake-token\\n") answer = { status: 401, body: "{}" };
const out = (f) => { const i = a.indexOf(f); return i < 0 ? undefined : a[i + 1]; };
if (out("-D")) fs.writeFileSync(out("-D"), "HTTP/1.1 " + answer.status + "\\r\\n" + (answer.location !== undefined ? "Location: " + answer.location + "\\r\\n" : "") + "\\r\\n");
if (out("-o") && out("-o") !== "/dev/null") fs.writeFileSync(out("-o"), answer.body ?? "");
if (a.includes("-w")) process.stdout.write(String(answer.status));
else if (a.includes("-sf") && answer.status >= 400) process.exit(22);
else process.stdout.write(answer.body ?? "");
`);
  // npm: deploy.sh installs the checkout's packages before any change; run only from the checkout root.
  fake("npm", `if (fs.realpathSync(process.cwd()) !== fs.realpathSync(process.env.ROOT)) process.exit(3);`);
  fake("sleep", "");
  writeFileSync(join(dir, "deploy.env"), Object.entries(CONFIG).map(([k, v]) => `${k}=${v}\n`).join(""));
  const inherited = { ...process.env };
  delete inherited.ANTWAR_DEPLOY_CONFIG;
  return {
    dir,
    env: { ...inherited, PATH: `${dir}:${process.env.PATH}`, CALLS: calls, REQUESTS: requests, STATE: statePath, ROOT: dir,
      BUILT: join(dir, "built"), ANTWAR_DEPLOY_CONFIG: join(dir, "deploy.env"), ANTWAR_ROLLBACK_DIR: dir,
      FAKE_DIGEST: digest("5"), IMAGE_EXISTS: "1", FAIL_DEPLOY: RECORDS, ...env },
    collect: (status: number | null, stdout: string, stderr: string) => {
      const lines = (f: string) => readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      return { status, stdout, stderr, calls: lines(calls) as string[][], requests: lines(requests) as Request[],
        state: JSON.parse(readFileSync(statePath, "utf8")) as State };
    },
  };
}
type Result = ReturnType<ReturnType<typeof setup>["collect"]>;

function runAsync(args: readonly string[], state: State, env: Record<string, string> = {}): Promise<Result> {
  const { dir, env: fullEnv, collect } = setup(state, env);
  return new Promise((done, fail) => {
    const child = spawn("bash", [script, ...args], { env: fullEnv });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", fail);
    child.on("close", (status) => {
      try { done(collect(status, stdout, stderr)); } catch (e) { fail(e); } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  });
}

const registryRequests = (r: Result) => r.requests.filter((q) => !q.url.startsWith(FS) && !q.url.startsWith(UPLOAD));
const firestoreReads = (r: Result) => r.requests.filter((q) => q.url === `${FS}/queueWaiting` || q.url === `${FS}/lobbies`);
// The running/<commit> objects written, in order, by the exact name each upload names.
const runningWrites = (r: Result) => r.requests.filter((q) => q.url.startsWith(UPLOAD))
  .map((q) => `gs://example-record-inputs/${decodeURIComponent(q.url.slice(UPLOAD.length))}`);
const overlapTag = (r: Result) => r.calls.filter((c) => c[0] === "gcloud" && c[3] === "update-traffic" && c[4] === RECORDS && c.includes("--set-tags"));

// The token reaches curl on stdin only, and only on requests to the registry's own host;
// curl is https only and never follows a redirect itself.
function expectTokenKeptToRegistry(r: Result) {
  for (const c of r.calls) expect(c.join(" "), c[0]).not.toContain("fake-token");
  for (const q of registryRequests(r)) {
    expect(q.url, q.url).toMatch(/^https:\/\//);
    expect(q.args, q.url).toEqual(expect.arrayContaining(["--proto", "=https"]));
    expect(q.args, q.url).not.toContain("-L");
    expect(q.auth, q.url).toBe(new URL(q.url).host === HOST ? "Authorization: Bearer fake-token\n" : "");
  }
}

function expectRolling(r: Result) {
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("stopping: deploying antwar-records failed");
  expect(runningWrites(r)).toEqual([
    `gs://example-record-inputs/${runningBuildName(OUT_SHA[RECORDS]!)}`, `gs://example-record-inputs/${runningBuildName(SHA)}`]);
  expect(overlapTag(r).map((c) => c[6])).toEqual([`r${OUT_SHA[RECORDS]!.slice(0, 8)}=${outRev(RECORDS)}`]);
  expect(firestoreReads(r)).toEqual([]);
  expectTokenKeptToRegistry(r);
}

function expectFullGate(r: Result, line: string) {
  expect(r.status).toBe(1);
  expect(r.stderr).toContain(` full gate: ${line}\n`);
  expect(r.stderr).toContain("stopping: deploying antwar-records failed");
  expect(firestoreReads(r).map((q) => q.url)).toEqual([`${FS}/queueWaiting`, `${FS}/lobbies`]);
  expect(runningWrites(r)).toEqual([]);
  expect(overlapTag(r)).toEqual([]);
  expectTokenKeptToRegistry(r);
}

const notShown = (svc: string, image: string, reason: string) =>
  `${svc} runs ${OUT_SHA[svc]}, which does not contain ${FIRST_SUPPORT}, and its image ${image} is not shown to support rolling: ${reason}`;

// The labels the real Dockerfile's final stage sets.
function dockerfileLabels(): Record<string, string> {
  const finalStage = readFileSync("Dockerfile", "utf8").split(/^FROM\s/m).at(-1)!;
  const labels: Record<string, string> = {};
  for (const line of finalStage.matchAll(/^LABEL\s+(.+)$/gm)) {
    for (const kv of line[1]!.trim().split(/\s+/)) labels[kv.slice(0, kv.indexOf("="))] = kv.slice(kv.indexOf("=") + 1);
  }
  return labels;
}

describe.concurrent("all: rolling selection without the support commits' history", () => {
  it("rolls when every outgoing image at the server repository carries the label", async () => {
    const r = await runAsync(["all", SHA], control());
    expectRolling(r);
    expect(r.stderr).toContain(` rolling deploy: every outgoing build contains ${SUPPORT} or carries ${KEY}=1 (by label: ${SERVICES.join(" ")})\n`);
    // One manifest and one config read per service.
    expect(registryRequests(r).map((q) => q.url)).toEqual(SERVICES.flatMap((s) => [manifestUrl(OUT_DIGEST[s]!), blobUrl(OUT_DIGEST[s]!)]));
  }, TIMEOUT);

  it("rolls when an image is an index with exactly one linux/amd64 manifest", async () => {
    const state = control();
    const amd64 = digest("6");
    Object.assign(state.registry, image(amd64), { [manifestUrl(OUT_DIGEST[RECORDS]!)]: { status: 200, body: index(["arm64", digest("7")], ["amd64", amd64]) } });
    const r = await runAsync(["all", SHA], state);
    expectRolling(r);
    expect(registryRequests(r).slice(0, 3).map((q) => q.url)).toEqual([manifestUrl(OUT_DIGEST[RECORDS]!), manifestUrl(amd64), blobUrl(amd64)]);
  }, TIMEOUT);

  it("round trip: an image built from the real Dockerfile and deployed by records mode is recognised by all", async () => {
    // The registry serves every config with the labels parsed from the Dockerfile's final stage.
    const labels = dockerfileLabels();
    const state = control();
    const built = digest("5");
    for (const d of [...Object.values(OUT_DIGEST), built]) Object.assign(state.registry, image(d, labels));
    const recordsCommit = "e".repeat(40);
    const deployed = await runAsync(["records", recordsCommit], state, { IMAGE_EXISTS: "0", FAIL_DEPLOY: "" });
    expect(deployed.status, deployed.stderr).toBe(0);
    expect(deployed.calls.some((c) => c[0] === "gcloud" && c[1] === "builds")).toBe(true);
    const records = deployed.state.services[RECORDS]!.latest;
    expect(deployed.state.revisions[records]).toEqual({ image: `${REPO}@${built}`, sha: recordsCommit });

    const r = await runAsync(["all", SHA], deployed.state);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(` rolling deploy: every outgoing build contains ${SUPPORT} or carries ${KEY}=1 (by label: ${SERVICES.join(" ")})\n`);
    expect(registryRequests(r).slice(0, 2).map((q) => q.url)).toEqual([manifestUrl(built), blobUrl(built)]);
    expect(runningWrites(r)).toEqual([
      `gs://example-record-inputs/${runningBuildName(recordsCommit)}`, `gs://example-record-inputs/${runningBuildName(SHA)}`]);
    expect(overlapTag(r).map((c) => c[6])).toEqual([`r${recordsCommit.slice(0, 8)}=${records}`]);
    expect(firestoreReads(r)).toEqual([]);
    expectTokenKeptToRegistry(r);
  }, TIMEOUT);

  it("still rolls on ancestry alone, with the existing line and no registry request, when the checkout holds the history", async () => {
    const state = control();
    for (const svc of SERVICES) Object.assign(state.registry, image(OUT_DIGEST[svc]!, {}));
    const r = await runAsync(["all", SHA], state, { SUPPORTED: [...new Set(Object.values(OUT_SHA))].join(" ") });
    expectRolling(r);
    expect(r.stderr).toContain(` rolling deploy: every outgoing build contains ${SUPPORT}\n`);
    expect(registryRequests(r)).toEqual([]);
    // The only token reads are the ones the running/<commit> uploads take, one each.
    const uploads = r.requests.filter((q) => q.url.startsWith(UPLOAD));
    expect(uploads).toHaveLength(2);
    expect(r.calls.filter((c) => c[0] === "gcloud" && c[1] === "auth")).toHaveLength(uploads.length);
    expect(r.calls.filter((c) => c[0] === "gcloud" && c[1] === "auth" && c[2] !== "print-access-token")).toEqual([]);
  }, TIMEOUT);

  it("rolls with a slot image outside the server repository accepted by ancestry, never requesting it", async () => {
    const state = control();
    const elsewhere = `europe-docker.pkg.dev/other-project/antwar/server@${OUT_DIGEST[SLOT]}`;
    state.revisions[outRev(SLOT)]!.image = elsewhere;
    const r = await runAsync(["all", SHA], state, { SUPPORTED: OUT_SHA[SLOT]! });
    expectRolling(r);
    expect(r.stderr).toContain(`(by label: ${SERVICES.filter((s) => s !== SLOT).join(" ")})\n`);
    expect(registryRequests(r).filter((q) => !q.url.startsWith(`https://${HOST}/`))).toEqual([]);
    expect(registryRequests(r).filter((q) => q.url.includes(OUT_DIGEST[SLOT]!.slice(7)))).toEqual([]);
  }, TIMEOUT);

  // Redirects the registry may answer with, each followed to a 200.
  const redirectCases: [name: string, chain: (from: string) => Record<string, Answer>, target: string, auth: string][] = [
    ["a relative same-host Location, re-requested with the token",
      (from) => ({ [from]: { status: 307, location: "/v2/example-project/antwar/server/blobs/moved" } }),
      `${REGISTRY}/blobs/moved`, "Authorization: Bearer fake-token\n"],
    ["three absolute same-host Locations, the most it follows",
      (from) => ({ [from]: { status: 302, location: `${REGISTRY}/hop1` }, [`${REGISTRY}/hop1`]: { status: 301, location: `${REGISTRY}/hop2` },
        [`${REGISTRY}/hop2`]: { status: 308, location: `${REGISTRY}/hop3` } }),
      `${REGISTRY}/hop3`, "Authorization: Bearer fake-token\n"],
    ["a cross-host https Location, fetched without the token",
      (from) => ({ [from]: { status: 307, location: "https://storage.example.com/blob/1?sig=x" } }),
      "https://storage.example.com/blob/1?sig=x", ""],
    ["a protocol-relative Location, fetched over https without the token",
      (from) => ({ [from]: { status: 303, location: "//storage.example.com/blob/2" } }),
      "https://storage.example.com/blob/2", ""],
  ];
  for (const [name, chain, target, auth] of redirectCases) {
    it(`rolls through ${name}`, async () => {
      const state = control();
      const from = blobUrl(OUT_DIGEST[RECORDS]!);
      Object.assign(state.registry, chain(from), { [target]: { status: 200, body: config({ [KEY]: "1" }) } });
      const r = await runAsync(["all", SHA], state);
      expectRolling(r);
      const reached = registryRequests(r).filter((q) => q.url === target);
      expect(reached.map((q) => q.auth)).toEqual([auth]);
    }, TIMEOUT);
  }

  // Each case changes exactly one service of the control fixture, so support cannot be established.
  const notEstablished: [name: string, svc: string, edit: (s: State) => string, reason: string, env?: Record<string, string>][] = [
    ["another repository of the same registry", SLOT, (s) => {
      const img = `${HOST}/example-project/antwar/preview@${OUT_DIGEST[SLOT]}`;
      s.revisions[outRev(SLOT)]!.image = img;
      return img;
    }, `outside ${REPO}, not read`],
    ["a registry on another host", GAME, (s) => {
      const img = `registry.example.com/antwar/server@${OUT_DIGEST[GAME]}`;
      s.revisions[outRev(GAME)]!.image = img;
      return img;
    }, `outside ${REPO}, not read`],
    ["no label", RECORDS, (s) => { Object.assign(s.registry, image(OUT_DIGEST[RECORDS]!, {})); return ""; }, `the config has no ${KEY} label`],
    ["the value \"0\"", SLOT, (s) => { Object.assign(s.registry, image(OUT_DIGEST[SLOT]!, { [KEY]: "0" })); return ""; }, `${KEY} is "0", not "1"`],
    ["a 401", GAME, (s) => { s.registry[manifestUrl(OUT_DIGEST[GAME]!)] = { status: 401 }; return ""; }, `${manifestUrl(OUT_DIGEST[GAME]!)} answers 401`],
    ["a 404", RECORDS, (s) => { s.registry[blobUrl(OUT_DIGEST[RECORDS]!)] = { status: 404 }; return ""; }, `${blobUrl(OUT_DIGEST[RECORDS]!)} answers 404`],
    ["a manifest that is not JSON", SLOT, (s) => { s.registry[manifestUrl(OUT_DIGEST[SLOT]!)] = { status: 200, body: "<html>" }; return ""; }, "the manifest is not JSON"],
    ["an index with no linux/amd64 entry", GAME, (s) => {
      s.registry[manifestUrl(OUT_DIGEST[GAME]!)] = { status: 200, body: index(["arm64", digest("7")]) };
      return "";
    }, "the index lists 0 linux/amd64 images, not 1"],
    ["an index with two linux/amd64 entries", RECORDS, (s) => {
      s.registry[manifestUrl(OUT_DIGEST[RECORDS]!)] = { status: 200, body: index(["amd64", digest("6")], ["amd64", digest("8")]) };
      return "";
    }, "the index lists 2 linux/amd64 images, not 1"],
    ["a redirect to http", SLOT, (s) => {
      s.registry[blobUrl(OUT_DIGEST[SLOT]!)] = { status: 302, location: `http://${HOST}/v2/example-project/antwar/server/blobs/moved` };
      return "";
    }, `${blobUrl(OUT_DIGEST[SLOT]!)} redirects to http://${HOST}/v2/example-project/antwar/server/blobs/moved, not https`],
    ["a redirect without a Location", GAME, (s) => { s.registry[blobUrl(OUT_DIGEST[GAME]!)] = { status: 302 }; return ""; },
      `${blobUrl(OUT_DIGEST[GAME]!)} answers 302 without a usable Location`],
    ["a fourth redirect", RECORDS, (s) => {
      const from = blobUrl(OUT_DIGEST[RECORDS]!);
      Object.assign(s.registry, { [from]: { status: 307, location: `${REGISTRY}/hop1` }, [`${REGISTRY}/hop1`]: { status: 307, location: `${REGISTRY}/hop2` },
        [`${REGISTRY}/hop2`]: { status: 307, location: `${REGISTRY}/hop3` }, [`${REGISTRY}/hop3`]: { status: 307, location: `${REGISTRY}/hop4` },
        [`${REGISTRY}/hop4`]: { status: 200, body: config({ [KEY]: "1" }) } });
      return "";
    }, `more than 3 redirects from ${blobUrl(OUT_DIGEST[RECORDS]!)}`],
  ];
  for (const [name, svc, edit, reason] of notEstablished) {
    it(`uses the full gate, naming ${svc} and the reason, for ${name}`, async () => {
      const state = control();
      const img = edit(state) || `${REPO}@${OUT_DIGEST[svc]}`;
      const r = await runAsync(["all", SHA], state);
      expectFullGate(r, notShown(svc, img, reason));
      // Nothing is requested outside the server repository, over http, or past the third redirect.
      expect(registryRequests(r).filter((q) => !q.url.startsWith(`${REGISTRY}/`))).toEqual([]);
      expect(registryRequests(r).filter((q) => q.url === `${REGISTRY}/hop4`)).toEqual([]);
    }, TIMEOUT);
  }

  it("uses the full gate, naming the first service and the reason, when no access token can be read", async () => {
    const r = await runAsync(["all", SHA], control(), { FAKE_NO_TOKEN: "1", ANTWAR_DEPLOY_ROUNDS: "1" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(` full gate: ${notShown(RECORDS, `${REPO}@${OUT_DIGEST[RECORDS]}`, "no registry access token")}\n`);
    // Under the full gate, with no token, the records swap waits on the global gate and the run stops there.
    expect(r.stderr).toContain("stopping: antwar-records is still blocked after 1 rounds: no Firestore access token");
    expect(r.requests).toEqual([]);
    expect(runningWrites(r)).toEqual([]);
    expect(overlapTag(r)).toEqual([]);
  }, TIMEOUT);
});
