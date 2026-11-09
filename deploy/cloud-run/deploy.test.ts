import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createIdentities } from "../../src/identity/identities.ts";
import { createLobbies, isExpired, LOBBY_TTL_MS } from "../../src/lobby/lobbies.ts";
import { markerName, parseInputObjectName, parseRunningBuildName, runningBuildName } from "../../src/records/input-store.ts";
import { MAX_FAILURES } from "../../src/records/service.ts";
import { SLOT_READY_PATH } from "../../src/server.ts";
import { firestoreFromEnv, type Fields, type Store } from "../../src/store/firestore.ts";

// deploy.sh against fake gcloud and git executables on PATH: the script's own
// shell logic runs, and every external call is recorded instead of made.
const script = resolve("deploy/cloud-run/deploy.sh");
// The private config file every run is given (config.sh), with made-up values.
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
// The username claim limit's rule every live game and slot server gets.
const CLIENT_SOURCE_ENV = "ANTWAR_USERNAME_CLAIM_LIMIT_RULE=client";
type Setting = keyof typeof CONFIG;
// The line probe.mjs prints for an empty-catalog skip; probe.test.ts checks the real one matches.
const SKIP_LINE = /^\S+ RESULT domain comparison SKIPPED \{/m;
const SHA = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const PROJECT_NUMBER = "123456789";
const PREVIEW_REPO = "australia-southeast1-docker.pkg.dev/example-project/antwar/preview";
const SERVER_REPO = "australia-southeast1-docker.pkg.dev/example-project/antwar/server";
const ACCOUNT = ["--account", "operator@example.com", "--project", "example-project"];
const REGION = ["--region", "australia-southeast1"];
// The slot mark's document path. deploy.sh's writes are asserted against it in the rolling
// tests and src/lobby/lobbies.ts's reads in "names and rules deploy.sh shares with src", so neither side drifts alone.
const withheldDoc = (slot: string) => `withheld/${slot}`;
// The antwars.ai global forwarding rules the fake gcloud lists, documentation-range
// addresses only (RFC 5737, RFC 3849): two rules on one IPv4 address, an IPv6 rule,
// and a rule outside the antwar-domain- namespace that is never read.
const RULES = [
  { name: "antwar-domain-https", IPAddress: "192.0.2.10", portRange: "443-443" },
  { name: "antwar-domain-http", IPAddress: "192.0.2.10", portRange: "80-80" },
  { name: "antwar-domain-https-v6", IPAddress: "2001:db8::a", portRange: "443-443" },
  { name: "other-rule", IPAddress: "198.51.100.7", portRange: "443-443" },
];
// What deploy.sh sets: the antwar-domain- addresses, deduplicated, sorted, comma-separated.
const LB = "192.0.2.10,2001:db8::a";
const RULES_LIST = ["compute", "forwarding-rules", "list", "--global", ...ACCOUNT, "--filter", "name~^antwar-domain-", "--format", "json"];
// The antwar variables before ANTWAR_LOAD_BALANCER_ADDRESS, so a test can show only it was added.
const GAME_ENV = `GCLOUD_PROJECT=example-project;ANTWAR_RECORD_INPUT_BUCKET=example-record-inputs;ANTWAR_CODE_VERSION=${SHA};ANTWAR_PUBLIC_SLOTS=8;ANTWAR_PRIVATE_SLOTS=8;ANTWAR_SLOT_URL_TEMPLATE=https://antwar-{slot}-${PROJECT_NUMBER}.australia-southeast1.run.app`;
const GAME_ENV_FLAG = `^;^${GAME_ENV};ANTWAR_LOAD_BALANCER_ADDRESS=${LB}`;
const scratch: string[] = [];
afterEach(() => { for (const p of scratch.splice(0)) rmSync(p, { recursive: true, force: true }); });

const url = (service: string) => `https://${service}-${PROJECT_NUMBER}.australia-southeast1.run.app`;
// The address a slot is woken at, with {slot} left for the server to fill.
const slotUrlTemplate = (prefix: string) => url(`${prefix}{slot}`);

interface Options {
  /** The image already exists, so no build runs. */
  readonly imageExists?: boolean;
  /** for-each-ref finds the commit on an origin branch. */
  readonly onOriginBranch?: boolean;
  /** merge-base --is-ancestor <sha> origin/main succeeds. */
  readonly onMain?: boolean;
  /** Names `gcloud run services list` returns. */
  readonly listed?: readonly string[];
  /** describe reports this host instead of the deterministic one. */
  readonly wrongUrl?: boolean;
  /** Edits the starting Cloud Run state of antwar and antwar-records. */
  readonly state?: (state: State) => void;
  /** update-traffic is accepted but changes nothing. */
  readonly ignoreTraffic?: boolean;
  /** deploy creates the revision but leaves traffic where it was. */
  readonly deployKeepsTraffic?: boolean;
  /** Extra environment for the script and the fakes. */
  readonly env?: Readonly<Record<string, string>>;
  /** Replaces settings of the config file; undefined leaves a setting out. */
  readonly config?: Partial<Record<Setting, string | undefined>>;
  /** ANTWAR_DEPLOY_CONFIG: null leaves it unset, a string names that path instead of the written file. */
  readonly configPath?: string | null;
  /** What the fake probe at the checkout root reports (default pass), or "real" for probe.mjs itself. */
  readonly probe?: "pass" | "skip" | "fail" | "silent" | "real";
}

// The Cloud Run state of the services the script retags, as the fake
// gcloud keeps it: each traffic entry is a revision's percent, its tag, or both.
// `created` is the latest created revision when it differs from the latest ready one.
interface TrafficEntry { revisionName: string; percent?: number; tag?: string; latestRevision?: boolean }
interface Revision { image: string; sha: string; cpu?: string; env?: string[]; ready?: boolean;
  /** The values a deploy gave, by name (a secret's value is "secret:<ref>"); describe shows them when known. */
  values?: Record<string, string> }
interface State {
  services: Record<string, { latest: string; created?: string; traffic: TrafficEntry[] }>;
  revisions: Record<string, Revision>;
  /** Services the fake create-only request created, with the identity and command it was given. */
  created?: { svc: string; serviceAccount: string; command: string[] }[];
  /** Services besides the slots that describe as not found until a deploy creates them. */
  absent?: string[];
  /** What the fake curl answers. A count is how many more reads see it busy. */
  curl?: CurlState;
  bucket?: BucketState;
}
interface CurlState {
  /** Reads of queueWaiting that show a waiting entry. */
  queue?: number;
  /** Reads of the lobbies' last page that show an open lobby, counted only once every other service is deployed. */
  lobbyAtGame?: number;
  /** Lobbies on the last page of every read, created ageMs before that read. */
  lobbies?: readonly StoredLobby[];
  /** Per slot: reads of slots/<slot> that find a holder. */
  holders?: Record<string, number>;
  /** Per slot: reads of /live/status that find a match playing. */
  playing?: Record<string, number>;
  /** Per slot: the status of an unauthenticated POST /operator/stop (default 401). */
  stop?: Record<string, number>;
  /** Per slot: statuses the next unauthenticated stops answer, one each, before `stop` applies. */
  stopSeq?: Record<string, number[]>;
  /** Per slot: the revision its instance record (instances/<slot>) names; unset, the serving revision. */
  instances?: Record<string, string>;
  /** Per slot: revisions the next instance-record reads show, one each, before `instances` applies. */
  instanceSeq?: Record<string, string[]>;
  /** Slots whose deploy is followed, before any traffic move, by an outgoing instance retaking the slot:
   * the record names the outgoing revision, and the superseded new instance answers 503 to the next request. */
  retakeAtDeploy?: readonly string[];
  /** Per slot: how many more requests the slot's superseded instance answers 503. */
  superseded?: Record<string, number>;
  /** Slots whose record no request moves: an instance of the serving revision never takes the slot back. */
  stuck?: readonly string[];
  /** The site's status (default 200). */
  site?: number;
  /** Slots whose withheld/<slot> PATCH or DELETE answers 500. */
  withholdFails?: readonly string[];
  releaseFails?: readonly string[];
  /** The withheld/<slot> marks currently stored. */
  withheld?: string[];
  /** Record input bucket object names whose media upload answers 403. */
  uploadFails?: readonly string[];
  /** Services another party creates just before this run's create-only request for them, which is then refused. */
  appearAtCreate?: readonly string[];
}
/** The record input bucket as the fake gcloud storage keeps it. */
interface BucketState {
  /** running/<commit> and any other object the script wrote. */
  objects: string[];
  /** Inputs and markers listed from the after-th listing (default 0) for `shows` listings. */
  listed?: { name: string; shows: number; after?: number }[];
  /** Listings served so far. */
  reads?: number;
}
interface StoredLobby { id: string; state: string; ageMs: number; mode?: string; seats?: number }
const RECORDS_OUT = "antwar-records-00004-abc";
const RECORDS_OUT_DIGEST = `sha256:${"c".repeat(64)}`;
const RECORDS_OUT_SHA = "d".repeat(40);
const GAME_OUT = "antwar-00008-jkl";
const GAME_OUT_SHA = "6b".repeat(20);
// A production-like shape: older revisions kept warm by tags.
const startingState = (): State => ({
  services: {
    "antwar-records": { latest: RECORDS_OUT, traffic: [
      { revisionName: RECORDS_OUT, percent: 100, latestRevision: true },
      { revisionName: "antwar-records-00002-def", tag: "r0000aaaa" },
      { revisionName: "antwar-records-00001-ghi", tag: "r0000bbbb" },
    ] },
    antwar: { latest: GAME_OUT, traffic: [
      { revisionName: GAME_OUT, percent: 100, latestRevision: true },
      { revisionName: "antwar-00007-mno", tag: "r0000cccc" },
      { revisionName: "antwar-00006-pqr", tag: "r0000aaaa" },
      { revisionName: "antwar-00005-stu", tag: "r0000dddd" },
    ] },
  },
  revisions: {
    [RECORDS_OUT]: { image: `${SERVER_REPO}@${RECORDS_OUT_DIGEST}`, sha: RECORDS_OUT_SHA },
    [GAME_OUT]: { image: `${SERVER_REPO}@sha256:${"e".repeat(64)}`, sha: GAME_OUT_SHA },
  },
});

function setup(options: Options, keep = true) {
  const dir = mkdtempSync(join(tmpdir(), "antwar-deploy-test-"));
  if (keep) scratch.push(dir);
  const calls = join(dir, "calls.jsonl");
  writeFileSync(calls, "");
  const statePath = join(dir, "state.json");
  const state = startingState();
  options.state?.(state);
  writeFileSync(statePath, JSON.stringify(state));
  const fake = (name: string, body: string) => writeFileSync(join(dir, name), `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify(["${name}", ...a, ...("${name}" === "gcloud" && process.env.CLOUDSDK_CORE_DISABLE_PROMPTS !== "1" ? ["<prompts enabled>"] : [])]) + "\\n");
${body}
`, { mode: 0o755 });
  fake("git", `
const rest = a[0] === "-C" ? a.slice(2) : a;
if (rest[0] === "rev-parse") console.log(process.env.ROOT);
else if (rest[0] === "for-each-ref") { if (process.env.ON_ORIGIN === "1") console.log("refs/remotes/origin/feature"); }
// An ancestry check of an outgoing build passes only for the SUPPORTED commits.
else if (rest[0] === "merge-base" && rest[3] !== "origin/main") process.exit((process.env.SUPPORTED ?? "").split(" ").includes(rest[3]) ? 0 : 1);
else if (rest[0] === "merge-base") process.exit(process.env.ON_MAIN === "1" ? 0 : 1);
else if (rest[0] === "archive") fs.writeFileSync(rest[rest.indexOf("-o") + 1], "");
`);
  fake("gcloud", `
const at = (...w) => w.every((x, i) => a[i] === x);
const st = JSON.parse(fs.readFileSync(process.env.STATE, "utf8"));
const save = () => fs.writeFileSync(process.env.STATE, JSON.stringify(st));
const flag = (f) => { const i = a.indexOf(f); return i < 0 ? undefined : a[i + 1]; };
const tagsOnly = (traffic) => traffic.filter((t) => t.tag).map((t) => ({ revisionName: t.revisionName, tag: t.tag }));
const untagged = (traffic) => traffic.filter((t) => t.percent).map(({ tag, ...t }) => t);
// A flag's KEY=VALUE pairs, split on gcloud's ^<delimiter>^ when given, else on commas.
const pairs = (v) => { const d = /^\\^([^^]+)\\^/.exec(v ?? ""); return (d ? v.slice(d[0].length).split(d[1]) : (v ?? "").split(",")).filter(Boolean); };
// Variable and secret names a deploy leaves on the new revision.
const names = (f) => pairs(flag(f)).map((kv) => kv.split("=")[0]);
// A slot service exists once deployed (deploy_named creates it without --no-traffic); before, describe cannot find it.
const SLOT_SERVICE = /^antwar-(preview-)?(public|private)-[0-9]+$/;
const CAN_BE_ABSENT = (svc) => SLOT_SERVICE.test(svc) || (st.absent ?? []).includes(svc);
const hostOf = (svc) => process.env.WRONG_URL === "1" ? "https://elsewhere.run.app" : "https://" + svc + "-" + process.env.FAKE_PROJECT_NUMBER + ".australia-southeast1.run.app";
// NO_NEW_REVISION=<service>: its deploy succeeds and creates nothing; FAIL_DEPLOY=<service>: it fails creating nothing.
if (at("run", "deploy") && [process.env.NO_NEW_REVISION, process.env.FAIL_DEPLOY].includes(a[2])) process.exit(process.env.FAIL_DEPLOY === a[2] ? 1 : 0);
// Like gcloud, a deploy that would create the service refuses --no-traffic and creates nothing.
if (at("run", "deploy") && CAN_BE_ABSENT(a[2]) && !st.services[a[2]] && a.includes("--no-traffic")) { console.error("ERROR: --no-traffic not supported when creating a new service."); process.exit(1); }
if (at("run", "deploy") && CAN_BE_ABSENT(a[2]) && !st.services[a[2]]) st.services[a[2]] = { latest: "", traffic: [] };
if (at("auth", "print-access-token")) { if (process.env.FAKE_NO_TOKEN === "1") process.exit(1); console.log("fake-token"); }
else if (at("run", "deploy") && st.services[a[2]]) {
  // A deploy creates a revision and moves all traffic to it, keeping every tag;
  // with --no-traffic, traffic stays where it was.
  const svc = st.services[a[2]];
  const before = st.revisions[svc.traffic.find((t) => t.percent)?.revisionName]?.env ?? [];
  const beforeValues = st.revisions[svc.traffic.find((t) => t.percent)?.revisionName]?.values ?? {};
  const sha = (flag("--set-env-vars") ?? flag("--update-env-vars") ?? "").match(/ANTWAR_CODE_VERSION=([0-9a-f]+)/)?.[1] ?? "";
  svc.latest = st.revisions[a[2] + "-new"] ? a[2] + "-new2" : a[2] + "-new";
  delete svc.created;
  // DROP_ENV=<service>:<name>: that service's new revision is created without <name>.
  const [dropSvc, dropName] = (process.env.DROP_ENV ?? "").split(":");
  // A slot's new instance boots and registers at once (src/lobby/lobbies.ts registerInstance):
  // last boot wins across revisions, so an outgoing instance started in the window takes it back.
  const slotName = a[2].match(/^antwar-((?:public|private)-[0-9]+)$/)?.[1];
  if (slotName && st.curl) {
    const outgoing = svc.traffic.find((t) => t.percent)?.revisionName;
    const retake = (st.curl.retakeAtDeploy ?? []).includes(slotName);
    st.curl.instances = { ...st.curl.instances, [slotName]: retake ? outgoing : svc.latest };
    if (retake) st.curl.superseded = { ...st.curl.superseded, [slotName]: 1 };
  }
  st.revisions[svc.latest] = {
    image: flag("--image") ?? "", sha: process.env.WRONG_VERSION === a[2] ? "f".repeat(40) : sha, cpu: flag("--cpu"),
    env: [...new Set([...(flag("--set-env-vars") || flag("--set-secrets") ? [] : before), ...names("--set-env-vars"), ...names("--update-env-vars"), ...names("--set-secrets"), ...names("--update-secrets")])],
    ready: process.env.NOT_READY !== a[2],
    values: Object.fromEntries(([
      ...(flag("--set-env-vars") || flag("--set-secrets") ? [] : Object.entries(beforeValues)),
      ...[...pairs(flag("--set-env-vars")), ...pairs(flag("--update-env-vars"))].map((kv) => [kv.split("=")[0], kv.slice(kv.indexOf("=") + 1)]),
      ...[...pairs(flag("--set-secrets")), ...pairs(flag("--update-secrets"))].map((kv) => [kv.split("=")[0], "secret:" + kv.slice(kv.indexOf("=") + 1)]),
    ]).filter(([n]) => !(dropSvc === a[2] && n === dropName))),
  };
  if (dropSvc === a[2]) st.revisions[svc.latest].env = st.revisions[svc.latest].env.filter((n) => n !== dropName);
  if (process.env.DEPLOY_KEEPS_TRAFFIC !== "1" && !a.includes("--no-traffic")) svc.traffic = [{ revisionName: svc.latest, percent: 100, latestRevision: true }, ...tagsOnly(svc.traffic)];
  // --no-traffic pins traffic that followed the latest revision to the revision it was on, by name.
  if (a.includes("--no-traffic")) svc.traffic = svc.traffic.map(({ latestRevision, ...t }) => t);
  save();
}
else if (at("run", "services", "update-traffic") && st.services[a[3]]) {
  const svc = st.services[a[3]];
  if (process.env.IGNORE_TRAFFIC !== "1") {
    if (a.includes("--to-latest")) svc.traffic = [{ revisionName: svc.latest, percent: 100, latestRevision: true }, ...tagsOnly(svc.traffic)];
    const to = flag("--to-revisions");
    if (to) svc.traffic = [{ revisionName: to.split("=")[0], percent: Number(to.split("=")[1]) }, ...tagsOnly(svc.traffic)];
    // KEEP_TAGS=<service>: that service's tags survive --clear-tags.
    if (a.includes("--clear-tags") && process.env.KEEP_TAGS !== a[3]) svc.traffic = untagged(svc.traffic);
    const set = flag("--set-tags");
    if (set && process.env.IGNORE_SET_TAGS !== a[3]) svc.traffic = [...untagged(svc.traffic), ...set.split(",").map((kv) => ({ revisionName: kv.split("=")[1], tag: kv.split("=")[0] }))];
    save();
  }
}
else if (at("run", "services", "describe") && st.services[a[3]]) {
  const svc = st.services[a[3]];
  console.log(JSON.stringify({ metadata: { annotations: { "run.googleapis.com/urls": JSON.stringify([hostOf(a[3])]) } },
    status: { url: "https://" + a[3] + "-hash-ts.a.run.app", latestReadyRevisionName: svc.latest, latestCreatedRevisionName: svc.created ?? svc.latest, traffic: svc.traffic } }));
}
else if (at("run", "services", "describe") && CAN_BE_ABSENT(a[3])) { console.error("ERROR: (gcloud.run.services.describe) Cannot find service [" + a[3] + "]"); process.exit(1); }
else if (at("run", "revisions", "describe")) {
  const rev = st.revisions[a[3]];
  if (!rev) process.exit(1);
  console.log(JSON.stringify({ metadata: { name: a[3] },
    status: { imageDigest: rev.image, conditions: [{ type: "Ready", status: rev.ready === false ? "False" : "True" }] },
    spec: { containers: [{ image: rev.image, resources: { limits: { cpu: rev.cpu ?? "1" } },
      env: [{ name: "ANTWAR_CODE_VERSION", value: rev.sha }, ...(rev.env ?? []).filter((n) => n !== "ANTWAR_CODE_VERSION").map((name) => {
        const v = rev.values?.[name];
        return v === undefined ? { name } : v.startsWith("secret:") ? { name, valueFrom: { secretKeyRef: { key: v.slice(7) } } } : { name, value: v };
      })] }] } }));
}
else if (at("artifacts", "docker", "images", "describe")) { if (process.env.IMAGE_EXISTS === "1" || fs.existsSync(process.env.BUILT)) console.log(process.env.FAKE_DIGEST); else process.exit(1); }
else if (at("builds", "submit")) fs.writeFileSync(process.env.BUILT, "");
else if (at("storage") && ["cp", "rm", "ls"].includes(a[1])) {
  // Objects in the record input bucket.
  const b = st.bucket ?? (st.bucket = { objects: [] });
  const PREFIX = "gs://example-record-inputs/";
  // Like gcloud, a stdin copy to X is refused when X is absent but objects X/... exist (X lists as a folder).
  const folder = (x) => !b.objects.includes(x) && b.objects.some((o) => o.startsWith(x + "/"));
  if (at("storage", "cp", "-") && a[3].startsWith(PREFIX) && folder(a[3].slice(PREFIX.length))) {
    fs.readFileSync(0);
    console.error("ERROR: (gcloud.storage.cp) Destination object name needed when source is stdin.");
    process.exit(1);
  }
  else if (at("storage", "cp", "-") && a[3].startsWith(PREFIX)) { fs.readFileSync(0); b.objects = [...new Set([...b.objects, a[3].slice(PREFIX.length)])]; }
  else if (at("storage", "rm") && b.objects.includes(a[2].slice(PREFIX.length))) b.objects = b.objects.filter((o) => o !== a[2].slice(PREFIX.length));
  else if (at("storage", "ls", PREFIX + "running/**")) {
    // Run marks and overlap marks; gcloud fails when the wildcard matches nothing.
    const running = b.objects.filter((o) => o.startsWith("running/"));
    if (process.env.BUCKET_UNREADABLE === "1" || running.length === 0) process.exit(1);
    for (const o of running) console.log(PREFIX + o);
  }
  else if (at("storage", "ls", PREFIX)) {
    if (process.env.BUCKET_UNREADABLE === "1") process.exit(1);
    const n = b.reads ?? 0;
    b.reads = n + 1;
    const shown = (b.listed ?? []).filter((o) => n >= (o.after ?? 0) && n < (o.after ?? 0) + o.shows).map((o) => o.name);
    for (const name of [...b.objects.filter((o) => !o.startsWith("running/")), ...shown]) console.log(PREFIX + name);
    if (b.objects.some((o) => o.startsWith("running/"))) console.log(PREFIX + "running/");
  }
  else process.exit(1);
  save();
}
else if (at("projects", "describe")) console.log(process.env.FAKE_PROJECT_NUMBER);
// The global forwarding rules, as FAKE_RULES gives them (FAIL: the list fails).
else if (at("compute", "forwarding-rules", "list")) { if (process.env.FAKE_RULES === "FAIL") process.exit(1); console.log(process.env.FAKE_RULES); }
else if (at("run", "services", "list")) console.log(process.env.LISTED);
else if (at("run", "services", "describe")) {
  const svc = a[3];
  console.log(JSON.stringify({ metadata: { annotations: { "run.googleapis.com/urls": JSON.stringify([hostOf(svc)]) } },
    status: { url: "https://" + svc + "-hash-ts.a.run.app", traffic: [{ tag: "dir", url: "https://dir---" + svc + "-hash.a.run.app" }] } }));
}
`);
  // Firestore and the services' addresses. The bearer must arrive on stdin.
  fake("curl", `
const url = a.find((x) => x.startsWith("https://")) ?? "";
const st = JSON.parse(fs.readFileSync(process.env.STATE, "utf8"));
const c = st.curl ?? {};
const save = () => fs.writeFileSync(process.env.STATE, JSON.stringify(st));
const busy = (counts, key) => { if (!counts || !(counts[key] > 0)) return false; counts[key] -= 1; save(); return true; };
const FS = "https://firestore.googleapis.com/v1/projects/example-project/databases/(default)/documents/namespaces/live";
let code = 200, body = "";
// A JSON-API media upload to the record input bucket writes the object of exactly that name.
const UPLOAD = "https://storage.googleapis.com/upload/storage/v1/b/example-record-inputs/o?uploadType=media&name=";
const RUN_CREATE = "https://run.googleapis.com/v2/projects/example-project/locations/australia-southeast1/services?serviceId=";
if (url.startsWith(UPLOAD)) {
  const header = a.includes("@-") ? fs.readFileSync(0, "utf8") : "";
  const name = decodeURIComponent(url.slice(UPLOAD.length));
  if (header !== "Authorization: Bearer fake-token\\n") code = 401;
  else if (a[a.indexOf("-X") + 1] !== "POST" || a[a.indexOf("--data-binary") + 1] !== "") code = 400;
  else if ((c.uploadFails ?? []).includes(name)) code = 403;
  else {
    const b = st.bucket ?? (st.bucket = { objects: [] });
    b.objects = [...new Set([...b.objects, name])];
    save();
  }
}
else if (url.startsWith(RUN_CREATE)) {
  // The Cloud Run Admin API's create: refuses (409) a service that exists, else creates it serving one revision.
  const header = a.includes("@-") ? fs.readFileSync(0, "utf8") : "";
  const svc = decodeURIComponent(url.slice(RUN_CREATE.length));
  const spec = JSON.parse(a[a.indexOf("--data") + 1] ?? "{}");
  if (header !== "Authorization: Bearer fake-token\\n") code = 401;
  else if (a[a.indexOf("-X") + 1] !== "POST" || !spec.template?.containers?.[0]?.image) code = 400;
  else {
    if ((c.appearAtCreate ?? []).includes(svc) && !st.services[svc]) {
      st.services[svc] = { latest: svc + "-00001-other", traffic: [{ revisionName: svc + "-00001-other", percent: 100, latestRevision: true }] };
    }
    if (st.services[svc]) code = 409;
    else {
      const rev = svc + "-00001-placeholder";
      st.services[svc] = { latest: rev, traffic: [{ revisionName: rev, percent: 100, latestRevision: true }] };
      st.revisions[rev] = { image: spec.template.containers[0].image, sha: "", env: [] };
      st.created = [...(st.created ?? []), { svc, serviceAccount: spec.template.serviceAccount, command: spec.template.containers[0].command }];
    }
    save();
  }
}
else if (url.startsWith(FS)) {
  const header = a.includes("@-") ? fs.readFileSync(0, "utf8") : "";
  if (header !== "Authorization: Bearer fake-token\\n") code = 401, body = "{\\"error\\":{}}";
  else if (url === FS + "/queueWaiting") body = JSON.stringify({ documents: [
    { name: FS + "/queueWaiting/ranked-2v2", fields: { entries: { stringValue: "" } } },
    { name: FS + "/queueWaiting/ranked-1v1", fields: { entries: { stringValue: busy(c, "queue") ? "id-1 id-2" : "" } } }] });
  else if (url === FS + "/lobbies" && !a.includes("pageToken=page/2+")) body = JSON.stringify({ documents: [
    { name: FS + "/lobbies/lobby-0001", fields: { state: { stringValue: "ended" } } }], nextPageToken: "page/2+" });
  else if (url === FS + "/lobbies") {
    const atGame = Object.entries(st.services).every(([name, s]) => name === "antwar" || s.latest === name + "-new");
    const stored = (c.lobbies ?? []).map((l) => ({ name: FS + "/lobbies/" + l.id, fields: {
      state: { stringValue: l.state }, createdAt: { stringValue: String(Date.now() - l.ageMs) }, mode: { stringValue: l.mode ?? "" },
      seats: { stringValue: JSON.stringify(Array.from({ length: l.seats ?? 0 }, (_, i) => ({ id: "p" + i, displayName: "P" + i, colony: 0 }))) } } }));
    body = JSON.stringify({ documents: [...stored, ...(atGame && busy(c, "lobbyAtGame") ? [{ name: FS + "/lobbies/lobby-7f3a", fields: { state: { stringValue: "holding" } } }] : [])] });
  }
  else if (url.startsWith(FS + "/slots/")) code = busy(c.holders, url.split("/").pop()) ? 200 : 404;
  else if (url.startsWith(FS + "/instances/")) {
    const slot = url.split("/").pop();
    const serving = st.services["antwar-" + slot]?.traffic.find((t) => t.percent === 100)?.revisionName;
    const seq = c.instanceSeq?.[slot];
    const revision = seq?.length ? seq.shift() : c.instances?.[slot] ?? serving;
    save();
    body = JSON.stringify({ name: url, fields: { runId: { stringValue: "run-1" }, revision: { stringValue: revision } } });
  }
  else if (url.startsWith(FS + "/withheld/")) {
    // The slot mark, set by PATCH and cleared by DELETE.
    const slot = url.split("/").pop(), method = a[a.indexOf("-X") + 1];
    const held = new Set(c.withheld ?? []);
    if (method === "PATCH" && !(c.withholdFails ?? []).includes(slot)) held.add(slot);
    else if (method === "DELETE" && !(c.releaseFails ?? []).includes(slot)) held.delete(slot);
    else code = 500;
    st.curl = { ...c, withheld: [...held] };
    save();
  }
  else code = 404;
} else {
  const slot = url.match(/^https:\\/\\/antwar-((?:public|private)-[0-9]+)-/)?.[1];
  if (url === "https://antwars.ai/") code = c.site ?? 200;
  else if (slot && url.endsWith("/live/status")) body = busy(c.playing, slot) ? '{"kind":"playing","match":3}' : '{"kind":"idle","match":null}';
  else if (slot && busy(c.superseded, slot)) code = 503;
  else if (slot && url.endsWith("/ready")) {
    // The request reaches the serving revision; an instance of it that does not hold the slot takes it.
    const serving = st.services["antwar-" + slot]?.traffic.find((t) => t.percent === 100)?.revisionName;
    if (c.instances?.[slot] !== undefined && c.instances[slot] !== serving && !(c.stuck ?? []).includes(slot)) { c.instances[slot] = serving; save(); }
    code = 200;
  }
  else if (slot && url.endsWith("/operator/stop") && a.includes("POST")) {
    const seq = c.stopSeq?.[slot];
    if (seq?.length) { code = seq.shift(); save(); }
    else code = c.stop?.[slot] ?? 401;
  }
  else code = 404;
}
if (a.includes("-w")) process.stdout.write(String(code));
else if (a.includes("-sf") && code >= 400) process.exit(22);
else process.stdout.write(body);
`);
  // npm: run only from the checkout root (exit 3 elsewhere); FAKE_NPM_FAIL=1 makes it fail.
  fake("npm", `if (fs.realpathSync(process.cwd()) !== fs.realpathSync(process.env.ROOT)) process.exit(3);
if (process.env.FAKE_NPM_FAIL === "1") process.exit(1);`);
  // TERM_ON_SLEEP: the run is sent SIGTERM while it sleeps, as an operator interrupting it would.
  fake("sleep", `if (process.env.TERM_ON_SLEEP === "1") process.kill(process.ppid, "SIGTERM");`);
  // The checkout root is ROOT (fake git rev-parse), so the deploy runs this probe.
  mkdirSync(join(dir, "deploy", "cloud-run"), { recursive: true });
  const probePath = join(dir, "deploy", "cloud-run", "probe.mjs");
  // "real": probe.mjs's own bytes, resolving its MCP SDK from this checkout. A symlink would not do: probe.mjs
  // runs only when invoked by its own path, so through a symlink it exits 0 having done nothing.
  if (options.probe === "real") {
    writeFileSync(probePath, readFileSync(resolve("deploy/cloud-run/probe.mjs")));
    symlinkSync(resolve("node_modules"), join(dir, "node_modules"));
  }
  else writeFileSync(probePath, `import { appendFileSync } from "node:fs";
const a = process.argv.slice(2);
appendFileSync(process.env.CALLS, JSON.stringify(["probe", ...a]) + "\\n");
const log = (...parts) => console.log(new Date().toISOString(), ...parts);
log("probe", a[0], a[1]);
const kind = ${JSON.stringify(options.probe ?? "pass")};
if (kind === "skip") log("RESULT domain comparison SKIPPED", JSON.stringify({ status: "skipped", pass: null, reason: "no public lobby available in both catalogs; stream comparison not performed" }));
if (kind === "pass") log("RESULT domain comparison", JSON.stringify({ pass: true, failures: [], status: "compared", lobbyId: "lobby-0001" }));
if (kind === "fail") { log("RESULT probe failed", "domain stream comparison failed; stop without workaround"); process.exitCode = 1; }
`);
  const configFile = join(dir, "deploy.env");
  writeFileSync(configFile, Object.entries({ ...CONFIG, ...options.config }).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}\n`).join(""));
  // A config the test runner happens to carry never reaches the script.
  const inherited = { ...process.env };
  delete inherited.ANTWAR_DEPLOY_CONFIG;
  const env = {
    ...inherited, PATH: `${dir}:${process.env.PATH}`, CALLS: calls, ROOT: dir, BUILT: join(dir, "built"),
    ...(options.configPath === null ? {} : { ANTWAR_DEPLOY_CONFIG: options.configPath ?? configFile }),
    FAKE_DIGEST: DIGEST, FAKE_PROJECT_NUMBER: PROJECT_NUMBER, FAKE_RULES: JSON.stringify(RULES), IMAGE_EXISTS: options.imageExists === false ? "0" : "1",
    ON_ORIGIN: options.onOriginBranch === false ? "0" : "1", ON_MAIN: options.onMain === false ? "0" : "1",
    LISTED: (options.listed ?? []).join("\n"), WRONG_URL: options.wrongUrl ? "1" : "0",
    STATE: statePath, IGNORE_TRAFFIC: options.ignoreTraffic ? "1" : "0", ANTWAR_ROLLBACK_DIR: dir,
    DEPLOY_KEEPS_TRAFFIC: options.deployKeepsTraffic ? "1" : "0",
    // One passing swap-check probe per slot keeps the 18-service runs near their old length; the tests of
    // the swap check itself pass ANTWAR_SWAP_STABLE: "" to run with the script's own default of 3.
    ANTWAR_SWAP_STABLE: "1", ...options.env,
  };
  const collect = (result: { status: number | null; stdout: string; stderr: string }) => {
    const all = readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
    // The one fixed place `all` leaves its outcome (ANTWAR_ROLLBACK_DIR is dir).
    const statusFile = join(dir, "antwar-deploy-status");
    return { ...result, dir, calls: all, gcloud: all.filter((c) => c[0] === "gcloud").map((c) => c.slice(1)),
      state: JSON.parse(readFileSync(statePath, "utf8")) as State, statusFile: existsSync(statusFile) ? readFileSync(statusFile, "utf8") : null };
  };
  return { env, collect };
}

function run(args: readonly string[], options: Options = {}, path = script) {
  const { env, collect } = setup(options);
  return collect(spawnSync("bash", [path, ...args], { encoding: "utf8", env }));
}

// The same run without blocking, so the 18-service runs of `all` (hundreds of
// fake calls each) can proceed side by side.
function runAsync(args: readonly string[], options: Options = {}): Promise<ReturnType<typeof run>> {
  // Concurrent tests share afterEach, so each async run removes its own scratch.
  const { env, collect } = setup(options, false);
  return new Promise((done, fail) => {
    const child = spawn("bash", [script, ...args], { env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", fail);
    child.on("close", (status) => {
      try { done(collect({ status, stdout, stderr })); } catch (e) { fail(e); }
      finally { rmSync(env.ROOT, { recursive: true, force: true }); }
    });
  });
}

// Every slot service has at most one instance and none while idle, and
// carries the template its server wakes other slots at. Its startup probe
// on /ready keeps an instance unroutable until it holds its slot, for at most 600 s.
const slotDeploy = (service: string, slot: string, namespace: string, repo: string, counts: string, extra = "") => [
  "run", "deploy", service, ...ACCOUNT, ...REGION, "--image", `${repo}@${DIGEST}`,
  "--set-env-vars", `ANTWAR_SLOT=${slot},ANTWAR_PUBLIC_URL=${url(service)},ANTWAR_STORE_NAMESPACE=${namespace},GCLOUD_PROJECT=example-project,${counts},ANTWAR_SLOT_URL_TEMPLATE=${slotUrlTemplate(namespace === "live" ? "antwar-" : "antwar-preview-")}${extra}`,
  "--set-secrets", "ANTWAR_PRIVATE_REPLAY_KEY=antwar-private-replay-key:1",
  "--service-account", "antwar-run@example-project.iam.gserviceaccount.com",
  "--min-instances", "0", "--max-instances", "1", "--no-cpu-throttling", "--cpu", "1", "--memory", "2Gi",
  "--timeout", "3600", "--concurrency", "1000",
  "--startup-probe", "httpGet.path=/ready,periodSeconds=1,failureThreshold=600,timeoutSeconds=1",
  "--ingress", "all", "--no-invoker-iam-check",
  "--labels", `app=antwar,commit=${SHA},antwar-slots=${namespace}`,
];
// deploy_named's calls (run_gcloud) put the account, project and region last, and an existing
// service is deployed with --no-traffic.
const last = (call: string[]) => [...call.slice(0, 3), ...call.slice(9), ...ACCOUNT, ...REGION];
const noTraffic = (call: string[]) => [...call.slice(0, -6), "--no-traffic", ...call.slice(-6)];
// deploy_named's reads, and its one traffic move: to the revision the deploy created, by name.
const named = (svc: string) => ["run", "services", "describe", svc, "--format", "json", ...ACCOUNT, ...REGION];
const namedRevision = (rev: string) => ["run", "revisions", "describe", rev, "--format", "json", ...ACCOUNT, ...REGION];
const toNew = (svc: string, rev = `${svc}-new`) => ["run", "services", "update-traffic", svc, "--to-revisions", `${rev}=100`, ...ACCOUNT, ...REGION];
// Each fake gcloud call is its own node process, about 150 ms here, so a run of 30 or more calls
// (`slots live` for its 16 slots, a four-service `slots preview`) passes vitest's 5-second default.
const LIVE_SLOTS_TIMEOUT = 60_000;

describe("slot startup probe", () => {
  it("probes the path a slot server answers 200 on only once it holds its slot", () => {
    expect(slotDeploy("s", "public-0", "live", "r", "c")).toContain(`httpGet.path=${SLOT_READY_PATH},periodSeconds=1,failureThreshold=600,timeoutSeconds=1`);
  });
});
const deploys = (gcloud: string[][]) => gcloud.filter((c) => c[0] === "run" && c[1] === "deploy");
const deletes = (gcloud: string[][]) => gcloud.filter((c) => c[0] === "run" && c[2] === "delete").map((c) => c[3]);
// A deploy's variables, as --set-env-vars or --update-env-vars gives them, split on gcloud's
// ^<delimiter>^ when the value starts with one, else on commas.
const envOf = (deploy: readonly string[]): Record<string, string> => {
  const at = deploy.includes("--set-env-vars") ? deploy.indexOf("--set-env-vars") : deploy.indexOf("--update-env-vars");
  const value = deploy[at + 1]!;
  const delimiter = /^\^([^^]+)\^/.exec(value);
  const list = delimiter ? value.slice(delimiter[0].length).split(delimiter[1]!) : value.split(",");
  return Object.fromEntries(list.map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
};
// The Firestore document URL a server started with env (on Cloud Run) reads for games/one:
// the project its shared store reaches, through src/store/firestore.ts firestoreFromEnv.
async function storeTarget(env: Record<string, string>): Promise<string | undefined> {
  const urls: string[] = [];
  const request: typeof fetch = async (input) => {
    urls.push(String(input));
    if (new URL(String(input)).hostname === "metadata.google.internal") return Response.json({ access_token: "metadata-token", expires_in: 3599 });
    return Response.json({ error: { status: "NOT_FOUND" } }, { status: 404 });
  };
  const store = firestoreFromEnv({ K_SERVICE: "antwar", ...env }, request);
  expect(await store!.get("games/one")).toBeNull();
  return urls.at(-1);
}
const storeDocument = (namespace: string) =>
  `https://firestore.googleapis.com/v1/projects/${CONFIG.PROJECT}/databases/(default)/documents/namespaces/${namespace}/games/one`;

// The existing paths, written out from deploy.sh:
// a slots refactor that changes any of their external calls fails here.
describe("game-server young-generation cap", () => {
  it("ships the cap in the image's game-server command, not in the record-service command", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    const start = pkg.scripts.start!.split(" ");
    expect(start).toEqual(["node", "--max-semi-space-size=8", "--import", "./src/ts-resolve.mjs", "src/main.ts"]);
    const docker = readFileSync("Dockerfile", "utf8");
    const commands = [...docker.matchAll(/^CMD\s+(\[.*\])\s*$/gm)];
    expect(JSON.parse(commands.at(-1)![1]!)).toEqual(["npm", "start"]);
    expect(pkg.scripts["record-service"]).toBe("node --import ./src/ts-resolve.mjs src/records/main.ts");
    // Exercise the actual shipped Node arguments without starting a server or accessing a provider.
    const probe = spawnSync(process.execPath, [...start.slice(1, -1), "--eval", "console.log(JSON.stringify(process.execArgv))"], { encoding: "utf8" });
    expect(probe.status, probe.stderr).toBe(0);
    expect(JSON.parse(probe.stdout)).toContain("--max-semi-space-size=8");
  });

  it("keeps the image command on live, preview and all live/preview slots", () => {
    for (const args of [[SHA], ["preview", SHA, "dir"], ["slots", "live", SHA], ["slots", "preview", SHA]]) {
      const r = run(args);
      expect(r.status, r.stderr).toBe(0);
      const services = deploys(r.gcloud);
      expect(services).toHaveLength(args[0] === "slots" ? args[1] === "live" ? 16 : 2 : 1);
      for (const service of services) {
        expect(service).not.toContain("--command");
        expect(service).not.toContain("--args");
      }
    }
  }, LIVE_SLOTS_TIMEOUT);
});

describe("existing deploy paths are unchanged", () => {
  const previewDeploy = (env: string[]) => [
    "run", "deploy", "antwar-preview", ...ACCOUNT, ...REGION, "--image", `${PREVIEW_REPO}@${DIGEST}`, "--tag", "dir", ...env,
    "--service-account", "antwar-run@example-project.iam.gserviceaccount.com", "--min-instances", "0", "--max-instances", "1",
    "--no-cpu-throttling", "--cpu", "1", "--memory", "2Gi", "--timeout", "3600", "--concurrency", "1000",
    "--ingress", "all", "--no-invoker-iam-check", "--labels", `app=antwar,commit=${SHA}`,
  ];
  const describeImage = ["artifacts", "docker", "images", "describe", `${PREVIEW_REPO}:${SHA}`, ...ACCOUNT, "--format", "value(image_summary.digest)"];
  const describePreview = ["run", "services", "describe", "antwar-preview", ...ACCOUNT, ...REGION, "--format", "json"];

  it("preview reuses the image by digest and deploys the tag, with comparison settings removed", () => {
    const r = run(["preview", SHA, "dir"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("https://dir---antwar-preview-hash.a.run.app\n");
    expect(r.calls.filter((c) => c[0] === "git").map((c) => c.slice(1))).toEqual([
      ["-C", resolve("deploy/cloud-run"), "rev-parse", "--show-toplevel"],
      ["-C", r.calls[1]![2]!, "fetch", "--quiet", "origin", "+refs/heads/*:refs/remotes/origin/*"],
      ["-C", r.calls[1]![2]!, "cat-file", "-e", `${SHA}^{commit}`],
      ["-C", r.calls[1]![2]!, "for-each-ref", "--contains", SHA, "refs/remotes/origin"],
    ]);
    expect(r.gcloud).toEqual([describeImage, previewDeploy(["--update-env-vars", "GCLOUD_PROJECT=example-project", "--remove-env-vars", "ANTWAR_RULES,ANTWAR_PLAYERS"]), describePreview]);
  });

  it("preview with comparison settings builds a missing image first", () => {
    const r = run(["preview", SHA, "dir", "v4", "2"], { imageExists: false });
    expect(r.status).toBe(0);
    expect(r.gcloud).toEqual([
      describeImage,
      ["builds", "submit", expect.stringMatching(/source\.tgz$/), ...ACCOUNT, ...REGION, "--tag", `${PREVIEW_REPO}:${SHA}`,
        "--service-account", "projects/example-project/serviceAccounts/antwar-build@example-project.iam.gserviceaccount.com",
        "--gcs-source-staging-dir", "gs://example-build/source", "--gcs-log-dir", "gs://example-build/logs"],
      describeImage,
      previewDeploy(["--update-env-vars", "GCLOUD_PROJECT=example-project,ANTWAR_RULES=v4,ANTWAR_PLAYERS=2"]),
      describePreview,
    ]);
  });

  it("preview still accepts any origin-branch commit and refuses one on no origin branch", () => {
    const r = run(["preview", SHA, "dir"], { onOriginBranch: false });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`refusing: ${SHA} is not a commit on any origin branch`);
    expect(r.gcloud).toEqual([]);
  });

  it("preview-remove removes only the tag", () => {
    const r = run(["preview-remove", "dir"]);
    expect(r.status).toBe(0);
    expect(r.gcloud).toEqual([["run", "services", "update-traffic", "antwar-preview", ...ACCOUNT, ...REGION, "--remove-tags", "dir"]]);
  });

  it("the live path builds and deploys antwar from main only", () => {
    const refused = run([SHA], { onMain: false });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(`refusing: ${SHA} is not a commit on origin/main`);
    expect(refused.gcloud).toEqual([]);

    const r = run([SHA]);
    expect(r.status).toBe(0);
    expect(r.gcloud).toEqual([
      ["projects", "describe", "example-project", "--account", "operator@example.com", "--format", "value(projectNumber)"],
      // The load balancer's addresses, read before anything is built or deployed.
      RULES_LIST,
      // The serving revision is read before the build, to become the rollback.
      ["run", "services", "describe", "antwar", ...ACCOUNT, ...REGION, "--format", "json"],
      ["run", "revisions", "describe", GAME_OUT, ...ACCOUNT, ...REGION, "--format", "json"],
      ["builds", "submit", expect.stringMatching(/source\.tgz$/), ...ACCOUNT, ...REGION, "--tag", `${SERVER_REPO}:${SHA}`,
        "--service-account", "projects/example-project/serviceAccounts/antwar-build@example-project.iam.gserviceaccount.com",
        "--gcs-source-staging-dir", "gs://example-build/source", "--gcs-log-dir", "gs://example-build/logs"],
      named("antwar"),
      ["run", "deploy", "antwar", "--image", `${SERVER_REPO}:${SHA}`,
        // The record handoff settings; the slot allocator's 8 public and 8 private
        // live slots and the address it wakes them at; the load balancer's addresses.
        // Variables set outside the script are kept.
        "--update-env-vars", `${GAME_ENV_FLAG};${CLIENT_SOURCE_ENV}`,
        "--service-account", "antwar-run@example-project.iam.gserviceaccount.com", "--min-instances", "1", "--max-instances", "1",
        "--max", "1", "--no-cpu-throttling", "--cpu", "1", "--memory", "2Gi", "--timeout", "3600", "--concurrency", "1000",
        "--ingress", "all", "--no-invoker-iam-check", "--labels", `app=antwar,commit=${SHA}`, "--no-traffic", ...ACCOUNT, ...REGION],
      // The revision the deploy created gets all traffic by name, once Ready.
      named("antwar"), namedRevision("antwar-new"), toNew("antwar"), named("antwar"),
      // Then only tags are replaced.
      ["run", "services", "update-traffic", "antwar", ...ACCOUNT, ...REGION, "--set-tags", `r6b6b6b6b=${GAME_OUT}`],
      ["run", "services", "describe", "antwar", ...ACCOUNT, ...REGION, "--format", "json"],
    ]);
  });

  it("every gcloud call disables prompts for itself", () => {
    for (const args of [["preview", SHA, "dir"], [SHA], ["slots", "preview", SHA], ["slots", "live", SHA]]) {
      expect(run(args, { listed: ["antwar-preview-public-1"] }).calls.flat()).not.toContain("<prompts enabled>");
    }
  }, LIVE_SLOTS_TIMEOUT);
});

describe("slots preview", () => {
  it("deploys one public and one private slot service by default under the preview namespace, without a replay bucket", () => {
    const r = run(["slots", "preview", SHA], { listed: ["antwar-preview-public-0", "antwar-preview-private-0"] });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`public-0 ${url("antwar-preview-public-0")}\nprivate-0 ${url("antwar-preview-private-0")}\n`);
    const counts = "ANTWAR_PUBLIC_SLOTS=1,ANTWAR_PRIVATE_SLOTS=1";
    expect(deploys(r.gcloud)).toEqual([
      last(slotDeploy("antwar-preview-public-0", "public-0", "preview", PREVIEW_REPO, counts)),
      last(slotDeploy("antwar-preview-private-0", "private-0", "preview", PREVIEW_REPO, counts)),
    ]);
    expect(r.gcloud.flat().join(" ")).not.toContain("ANTWAR_REPLAY_BUCKET");
    expect(deletes(r.gcloud)).toEqual([]);
    // The existing services are never named.
    expect(r.gcloud.some((c) => c.includes("antwar") || c.includes("antwar-preview"))).toBe(false);
  });

  it("takes the slot counts as arguments and deletes preview slot services beyond them", () => {
    const r = run(["slots", "preview", SHA, "3", "1"], { listed: ["antwar-preview-public-0", "antwar-preview-private-0", "antwar-preview-private-1"] });
    expect(r.status).toBe(0);
    const counts = "ANTWAR_PUBLIC_SLOTS=3,ANTWAR_PRIVATE_SLOTS=1";
    expect(deploys(r.gcloud)).toEqual([
      last(slotDeploy("antwar-preview-public-0", "public-0", "preview", PREVIEW_REPO, counts)),
      last(slotDeploy("antwar-preview-public-1", "public-1", "preview", PREVIEW_REPO, counts)),
      last(slotDeploy("antwar-preview-public-2", "public-2", "preview", PREVIEW_REPO, counts)),
      last(slotDeploy("antwar-preview-private-0", "private-0", "preview", PREVIEW_REPO, counts)),
    ]);
    expect(deletes(r.gcloud)).toEqual(["antwar-preview-private-1"]);
  }, LIVE_SLOTS_TIMEOUT);

  it("uses the preview provenance check: refuses a commit on no origin branch", () => {
    const r = run(["slots", "preview", SHA], { onOriginBranch: false });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`refusing: ${SHA} is not a commit on any origin branch`);
    expect(r.gcloud).toEqual([]);
  });

  it("stops when a slot service does not serve the address its server registers", () => {
    const r = run(["slots", "preview", SHA], { wrongUrl: true });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`deployed antwar-preview-public-0, but it does not serve ${url("antwar-preview-public-0")}`);
    expect(deploys(r.gcloud)).toHaveLength(1);
  });

  it("refuses malformed arguments before any call", () => {
    for (const args of [["slots", "preview", SHA, "0", "1"], ["slots", "preview", SHA, "2"], ["slots", "preview", "abc"], ["slots", "staging", SHA], ["slots-remove", "live"]]) {
      const r = run(args);
      expect(r.status).toBe(2);
      expect(r.gcloud).toEqual([]);
    }
  });

  it("slots-remove deletes every preview slot service and nothing else", () => {
    const r = run(["slots-remove", "preview"], { listed: ["antwar-preview-public-0", "antwar-preview-private-0"] });
    expect(r.status).toBe(0);
    expect(deletes(r.gcloud)).toEqual(["antwar-preview-public-0", "antwar-preview-private-0"]);
    const odd = run(["slots-remove", "preview"], { listed: ["antwar"] });
    expect(odd.status).toBe(1);
    expect(deletes(odd.gcloud)).toEqual([]);
  });
});

describe("slots live declaration", () => {
  it("deploys 8 public and 8 private on-demand slots under the live namespace from a main commit, with the replay bucket and the record handoff", () => {
    const r = run(["slots", "live", SHA], { listed: ["antwar-preview-public-0"] });
    expect(r.status).toBe(0);
    // 8 public and 8 private, each at most one instance and none while idle.
    const counts = "ANTWAR_PUBLIC_SLOTS=8,ANTWAR_PRIVATE_SLOTS=8";
    // Each recorded match is handed to the record service at the deployed commit.
    const live = `,ANTWAR_REPLAY_BUCKET=example-replays,ANTWAR_RECORD_INPUT_BUCKET=example-record-inputs,ANTWAR_CODE_VERSION=${SHA},${CLIENT_SOURCE_ENV}`;
    const slots = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => `public-${n}`).concat([0, 1, 2, 3, 4, 5, 6, 7].map((n) => `private-${n}`));
    expect(deploys(r.gcloud)).toEqual(slots.map((slot) => last(slotDeploy(`antwar-${slot}`, slot, "live", SERVER_REPO, counts, live))));
    // Each slot's traffic moves to the revision its deploy created, by name.
    for (const slot of slots) expect(r.gcloud, slot).toContainEqual(toNew(`antwar-${slot}`));
    // Live never lists or deletes services.
    expect(r.gcloud.filter((c) => c[0] === "run" && (c[2] === "list" || c[2] === "delete"))).toEqual([]);
  }, LIVE_SLOTS_TIMEOUT);

  it("refuses a commit not on main, and takes no slot counts", () => {
    const r = run(["slots", "live", SHA], { onMain: false });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`refusing: ${SHA} is not a commit on origin/main`);
    expect(r.gcloud).toEqual([]);
    expect(run(["slots", "live", SHA, "2", "2"]).status).toBe(2);
  });
});

// The record service is its own Cloud Run service with its own identity.
describe("records", () => {
  const RECORDS_SA = "antwar-records@example-project.iam.gserviceaccount.com";
  // deploy_named: --no-traffic, the account, project and region last.
  const recordsDeploy = noTraffic(last([
    "run", "deploy", "antwar-records", ...ACCOUNT, ...REGION, "--image", `${SERVER_REPO}@${DIGEST}`,
    "--command", "npm", "--args", "run,record-service",
    "--set-env-vars", `ANTWAR_RECORD_INPUT_BUCKET=example-record-inputs,ANTWAR_REPLAY_BUCKET=example-replays,ANTWAR_CODE_VERSION=${SHA},NODE_OPTIONS=--max-old-space-size=512`,
    "--set-secrets", "ANTWAR_PRIVATE_REPLAY_KEY=antwar-private-replay-key:1",
    "--service-account", RECORDS_SA,
    "--min-instances", "1", "--max-instances", "1", "--no-cpu-throttling", "--cpu", "1", "--memory", "2Gi",
    "--ingress", "internal", "--invoker-iam-check",
    "--labels", `app=antwar,commit=${SHA}`,
  ]));

  const describeRecords = ["run", "services", "describe", "antwar-records", ...ACCOUNT, ...REGION, "--format", "json"];
  const describeOutgoing = ["run", "revisions", "describe", RECORDS_OUT, ...ACCOUNT, ...REGION, "--format", "json"];
  const retagRecords = ["run", "services", "update-traffic", "antwar-records", "--clear-tags", ...ACCOUNT, ...REGION];
  // Before and after the deploy, deploy_named reads the service; the new revision is Ready and gets all traffic by name.
  const deployRecords = [named("antwar-records"), recordsDeploy, named("antwar-records"), namedRevision("antwar-records-new"), toNew("antwar-records"), named("antwar-records")];
  const lookupTag = (sha: string) => ["artifacts", "docker", "images", "describe", `${SERVER_REPO}:${sha}`, ...ACCOUNT, "--format", "value(image_summary.digest)"];

  it("deploys only antwar-records, as antwar-records, from the same commit's server image", () => {
    const r = run(["records", SHA]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.gcloud).toEqual([
      describeRecords,
      describeOutgoing,
      ["artifacts", "docker", "images", "describe", `${SERVER_REPO}:${SHA}`, ...ACCOUNT, "--format", "value(image_summary.digest)"],
      ...deployRecords,
      retagRecords,
      describeRecords,
    ]);
    // No game-server service, identity, list or delete is ever named.
    const flat = r.gcloud.flat();
    for (const name of ["antwar", "antwar-preview", "antwar-public-0", "antwar-private-0", "antwar-run@example-project.iam.gserviceaccount.com"]) {
      expect(flat).not.toContain(name);
    }
    expect(r.gcloud.filter((c) => c[0] === "run" && (c[2] === "delete" || c[2] === "list"))).toEqual([]);
    expect(r.calls.flat()).not.toContain("<prompts enabled>");
  });

  it("builds a missing image from the commit first", () => {
    const r = run(["records", SHA], { imageExists: false });
    expect(r.status).toBe(0);
    expect(r.gcloud.map((c) => c.slice(0, 3))).toEqual([
      ["run", "services", "describe"], ["run", "revisions", "describe"],
      ["artifacts", "docker", "images"], ["builds", "submit", expect.any(String)], ["artifacts", "docker", "images"],
      ["run", "services", "describe"], ["run", "deploy", "antwar-records"], ["run", "services", "describe"], ["run", "revisions", "describe"],
      ["run", "services", "update-traffic"], ["run", "services", "describe"], ["run", "services", "update-traffic"], ["run", "services", "describe"],
    ]);
    expect(deploys(r.gcloud)).toEqual([recordsDeploy]);
  });

  // An older records revision kept warm by traffic or a tag races the new one.
  it("leaves only the new revision with traffic or a tag, and states the outgoing digest as the rollback path", () => {
    const r = run(["records", SHA]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.state.services["antwar-records"]!.traffic).toEqual([{ revisionName: "antwar-records-new", percent: 100 }]);
    // The outgoing revision's full spec is saved, and its digest is the rollback.
    const spec = JSON.parse(readFileSync(join(r.dir, `records-rollback-${RECORDS_OUT}.json`), "utf8"));
    expect(spec.status.imageDigest).toBe(`${SERVER_REPO}@${RECORDS_OUT_DIGEST}`);
    expect(r.stdout).toBe(`${script} records-rollback ${RECORDS_OUT_SHA} ${RECORDS_OUT_DIGEST}\n`);
    expect(r.stderr).toContain(`records rollback: image ${SERVER_REPO}@${RECORDS_OUT_DIGEST} from ${RECORDS_OUT}`);
    // The game service is never retagged by records, and no revision is ever deleted.
    expect(r.state.services.antwar).toEqual(startingState().services.antwar);
  });

  it("the printed rollback redeploys records from the saved image digest and outgoing commit", () => {
    const first = run(["records", SHA]);
    expect(first.status, first.stderr).toBe(0);
    const [path, ...args] = first.stdout.trim().split(" ");
    expect(path).toBe(script);
    // The registry tags the outgoing commit's image with the outgoing digest.
    const r = run(args, { env: { FAKE_DIGEST: RECORDS_OUT_DIGEST } });
    expect(r.status, r.stderr).toBe(0);
    expect(deploys(r.gcloud)).toEqual([recordsDeploy.map((x) =>
      x === `${SERVER_REPO}@${DIGEST}` ? `${SERVER_REPO}@${RECORDS_OUT_DIGEST}` : x.replaceAll(SHA, RECORDS_OUT_SHA))]);
    // One read of the commit's tag binds the digest to it, before the
    // deploy; nothing is built, and older tags are cleared again.
    expect(r.gcloud.filter((c) => c[0] === "artifacts" || c[0] === "builds")).toEqual([lookupTag(RECORDS_OUT_SHA)]);
    expect(r.gcloud.findIndex((c) => c[0] === "artifacts")).toBeLessThan(r.gcloud.findIndex((c) => c[1] === "deploy"));
    expect(r.gcloud).toContainEqual(retagRecords);
    expect(r.state.services["antwar-records"]!.traffic).toEqual([{ revisionName: "antwar-records-new", percent: 100 }]);
  });

  it("stops non-zero, naming each revision still kept warm, when the retag does not take", () => {
    const r = run(["records", SHA], { env: { KEEP_TAGS: "antwar-records" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("antwar-records: unexpected tag r0000aaaa on antwar-records-00002-def");
    expect(r.stderr).toContain("antwar-records: unexpected tag r0000bbbb on antwar-records-00001-ghi");
    expect(r.stderr).toContain(`deployed ${SHA}, but antwar-records still keeps an older revision warm`);
    expect(r.stderr).not.toContain(` done ${SHA}`);
  });

  it("stops non-zero, naming the older revision, when traffic stays on it", () => {
    const r = run(["records", SHA], { ignoreTraffic: true, deployKeepsTraffic: true, state: (s) => {
      s.services["antwar-records"]!.traffic = [{ revisionName: RECORDS_OUT, percent: 100 }];
    } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`stopping: antwar-records serves ${RECORDS_OUT} at 100%, not its new revision antwar-records-new, after its traffic move\n`);
    expect(r.gcloud.filter((c) => c.includes("--clear-tags"))).toEqual([]);
  });

  it("refuses before any build or deploy when the rollback path cannot be read", () => {
    const split = run(["records", SHA], { state: (s) => {
      s.services["antwar-records"]!.traffic = [{ revisionName: RECORDS_OUT, percent: 50 }, { revisionName: "antwar-records-00002-def", percent: 50 }];
    } });
    expect(split.status).toBe(1);
    expect(split.stderr).toContain("refusing: cannot read the one revision serving antwar-records");
    expect(split.gcloud).toEqual([describeRecords]);

    const noVersion = run(["records", SHA], { state: (s) => { s.revisions[RECORDS_OUT]!.sha = ""; } });
    expect(noVersion.status).toBe(1);
    expect(noVersion.stderr).toContain(`refusing: cannot read the image digest and ANTWAR_CODE_VERSION of ${RECORDS_OUT}`);
    expect(noVersion.gcloud).toEqual([describeRecords, describeOutgoing]);
  });

  // A digest not built from the given commit is never deployed.
  it("records-rollback refuses a digest that is not the given commit's image, before any deploy or build", () => {
    const mismatched = run(["records-rollback", RECORDS_OUT_SHA, RECORDS_OUT_DIGEST]);
    expect(mismatched.status).toBe(1);
    expect(mismatched.stderr).toContain(
      `refusing: ${RECORDS_OUT_DIGEST} is not the image built from ${RECORDS_OUT_SHA} (${SERVER_REPO}:${RECORDS_OUT_SHA} is ${DIGEST})`);
    expect(mismatched.gcloud).toEqual([describeRecords, describeOutgoing, lookupTag(RECORDS_OUT_SHA)]);

    const untagged = run(["records-rollback", RECORDS_OUT_SHA, RECORDS_OUT_DIGEST], { imageExists: false });
    expect(untagged.status).toBe(1);
    expect(untagged.stderr).toContain(`(${SERVER_REPO}:${RECORDS_OUT_SHA} is unreadable)`);
    expect(untagged.gcloud).toEqual([describeRecords, describeOutgoing, lookupTag(RECORDS_OUT_SHA)]);
  });

  it("records-rollback refuses malformed arguments before any call", () => {
    for (const args of [["records-rollback", SHA], ["records-rollback", SHA, "sha256:abc"], ["records-rollback", "abc", RECORDS_OUT_DIGEST], ["records-rollback", SHA, RECORDS_OUT_DIGEST, "x"]]) {
      const r = run(args);
      expect(r.status).toBe(2);
      expect(r.gcloud).toEqual([]);
    }
  });

  it("refuses a commit not on main and malformed arguments before any call", () => {
    const refused = run(["records", SHA], { onMain: false });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(`refusing: ${SHA} is not a commit on origin/main`);
    expect(refused.gcloud).toEqual([]);
    for (const args of [["records"], ["records", "abc"], ["records", SHA, "extra"]]) {
      const r = run(args);
      expect(r.status).toBe(2);
      expect(r.gcloud).toEqual([]);
    }
  });

  it("record-service-setup.sh creates the identity and private input bucket and makes only the five grants", () => {
    const r = run([], {}, resolve("deploy/cloud-run/record-service-setup.sh"));
    expect(r.status).toBe(0);
    const input = "gs://example-record-inputs";
    const member = (sa: string) => `serviceAccount:${sa}`;
    expect(r.gcloud).toEqual([
      ["iam", "service-accounts", "create", "antwar-records", "--display-name", "antwar record service", ...ACCOUNT],
      ["storage", "buckets", "create", input, "--location", "australia-southeast1",
        "--uniform-bucket-level-access", "--public-access-prevention", "--soft-delete-duration", "0", ...ACCOUNT],
      ["storage", "buckets", "update", input, "--update-labels", "app=antwar", ...ACCOUNT],
      ["storage", "buckets", "add-iam-policy-binding", input, "--member", member("antwar-run@example-project.iam.gserviceaccount.com"), "--role", "roles/storage.objectCreator", ...ACCOUNT],
      // Read-back of handover saves only (test/slots/handover-save-read-grant.test.ts).
      ["storage", "buckets", "add-iam-policy-binding", input, "--member", member("antwar-run@example-project.iam.gserviceaccount.com"), "--role", "roles/storage.objectViewer",
        "--condition", "expression=resource.name.startsWith(\"projects/_/buckets/example-record-inputs/objects/handover/\"),title=antwar-run-handover-saves-read", ...ACCOUNT],
      ["storage", "buckets", "add-iam-policy-binding", input, "--member", member(RECORDS_SA), "--role", "roles/storage.objectUser", ...ACCOUNT],
      ["storage", "buckets", "add-iam-policy-binding", "gs://example-replays", "--member", member(RECORDS_SA), "--role", "roles/storage.objectUser", ...ACCOUNT],
      ["secrets", "add-iam-policy-binding", "antwar-private-replay-key", "--member", member(RECORDS_SA), "--role", "roles/secretmanager.secretAccessor", ...ACCOUNT],
    ]);
    // No lifecycle rule on the input bucket.
    expect(r.gcloud.flat().some((x) => x.includes("lifecycle"))).toBe(false);
    expect(r.calls.flat()).not.toContain("<prompts enabled>");
    expect(run(["extra"], {}, resolve("deploy/cloud-run/record-service-setup.sh")).status).toBe(2);
  });
});

// Every setting comes from the private config file, with no default (config.sh).
describe("private deploy config", () => {
  const SETUP = resolve("deploy/cloud-run/record-service-setup.sh");
  const ALL = Object.keys(CONFIG) as Setting[];
  const BUILD: Setting[] = ["ACCOUNT", "PROJECT", "BUILD_BUCKET", "BUILD_SA"];
  // Each mode, and the settings it needs: exactly these, in this order.
  const MODES: [string, readonly string[], readonly Setting[], string?][] = [
    ["all", ["all", SHA], ALL],
    ["records", ["records", SHA], [...BUILD, "RECORDS_SA", "RECORD_INPUT_BUCKET", "REPLAY_BUCKET"]],
    ["records-rollback", ["records-rollback", SHA, DIGEST], ["ACCOUNT", "PROJECT", "RECORDS_SA", "RECORD_INPUT_BUCKET", "REPLAY_BUCKET"]],
    ["slots live", ["slots", "live", SHA], [...BUILD, "RUN_SA", "RECORD_INPUT_BUCKET", "REPLAY_BUCKET"]],
    ["slots preview", ["slots", "preview", SHA], [...BUILD, "RUN_SA"]],
    ["slots-remove", ["slots-remove", "preview"], ["ACCOUNT", "PROJECT"]],
    ["preview", ["preview", SHA, "dir"], [...BUILD, "RUN_SA"]],
    ["preview-remove", ["preview-remove", "dir"], ["ACCOUNT", "PROJECT"]],
    ["the live path", [SHA], [...BUILD, "RUN_SA", "RECORD_INPUT_BUCKET"]],
    ["record-service-setup.sh", [], ["ACCOUNT", "PROJECT", "RECORDS_SA", "RUN_SA", "RECORD_INPUT_BUCKET", "REPLAY_BUCKET"], SETUP],
  ];
  // Every setting also present in the environment, which must never supply one.
  const leaked = Object.fromEntries(ALL.map((name) => [name, `leaked-${name.toLowerCase()}`]));
  const without = (names: readonly Setting[]) => Object.fromEntries(names.map((name) => [name, undefined]));

  for (const [label, args, needed, path] of MODES) {
    it(`${label} stops before any call, naming its settings, when the file is unset, missing or unreadable`, () => {
      const absent = join(tmpdir(), `antwar-no-such-config-${process.pid}`);
      for (const [configPath, reason] of [[null, "ANTWAR_DEPLOY_CONFIG is not set"], [absent, "missing or unreadable"], [tmpdir(), "missing or unreadable"]] as const) {
        const r = run(args, { configPath, env: leaked }, path);
        expect(r.status, `${configPath}`).toBe(1);
        expect(r.stderr).toContain(reason);
        expect(r.stderr).toContain(`must set ${needed.join(" ")}\n`);
        expect(r.calls).toEqual([]);
      }
    });

    it(`${label} stops before any call, naming exactly the settings the file lacks, even with them in the environment`, () => {
      const none = run(args, { config: without(ALL), env: leaked }, path);
      expect(none.status).toBe(1);
      expect(none.stderr).toMatch(new RegExp(`refusing: the deploy config file \\S+ lacks ${needed.join(" ")}\n$`));
      expect(none.calls).toEqual([]);
      for (const name of needed) {
        const r = run(args, { config: { [name]: undefined }, env: leaked }, path);
        expect(r.status, name).toBe(1);
        expect(r.stderr, name).toMatch(new RegExp(` lacks ${name}\n$`));
        expect(r.calls, name).toEqual([]);
      }
      // A setting given empty is missing too.
      const empty = run(args, { config: { [needed[0]!]: "" } }, path);
      expect(empty.stderr).toMatch(new RegExp(` lacks ${needed[0]}\n$`));
      expect(empty.calls).toEqual([]);
    });
  }

  it("refuses a config file it cannot read", () => {
    if (process.getuid?.() === 0) return; // root reads a mode-000 file
    const dir = mkdtempSync(join(tmpdir(), "antwar-config-"));
    scratch.push(dir);
    const file = join(dir, "deploy.env");
    writeFileSync(file, Object.entries(CONFIG).map(([k, v]) => `${k}=${v}\n`).join(""), { mode: 0o000 });
    const r = run(["preview-remove", "dir"], { configPath: file });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`refusing: the deploy config file ${file} is missing or unreadable; it must set ACCOUNT PROJECT\n`);
    expect(r.calls).toEqual([]);
  });

  it("reads values literally and ignores comments, blank lines and other names", () => {
    const dir = mkdtempSync(join(tmpdir(), "antwar-config-"));
    scratch.push(dir);
    const file = join(dir, "deploy.env");
    const ran = join(dir, "ran");
    writeFileSync(file, `# a comment\n\nACCOUNT=$(touch ${ran})\nOTHER=x\nPROJECT=a=b $HOME\n`);
    const r = run(["preview-remove", "dir"], { configPath: file });
    expect(r.status, r.stderr).toBe(0);
    expect(r.gcloud).toEqual([["run", "services", "update-traffic", "antwar-preview", "--account", `$(touch ${ran})`, "--project", "a=b $HOME", ...REGION, "--remove-tags", "dir"]]);
    expect(() => readFileSync(join(dir, "ran"))).toThrow();
  });

  it("gives every slot, preview and game service the config file's project for its shared store", async () => {
    const cases: [string[], string][] = [[["slots", "preview", SHA], "preview"], [["slots", "live", SHA], "live"], [["preview", SHA, "dir"], "preview"], [["preview", SHA, "dir", "v4", "2"], "preview"], [[SHA], "live"]];
    for (const [args, namespace] of cases) {
      const r = run(args, { config: { PROJECT: "another-project" } });
      expect(r.status, r.stderr).toBe(0);
      for (const d of deploys(r.gcloud)) {
        const env = envOf(d);
        expect(env.GCLOUD_PROJECT, `${args.join(" ")} ${d[2]}`).toBe("another-project");
        // The preview and game services' namespace is set outside the script and kept.
        const target = await storeTarget({ ANTWAR_STORE_NAMESPACE: namespace, ...env });
        expect(target).toBe(storeDocument(namespace).replace(CONFIG.PROJECT, "another-project"));
        const unprojected = { ...env };
        delete unprojected.GCLOUD_PROJECT;
        expect(() => firestoreFromEnv({ ANTWAR_STORE_NAMESPACE: namespace, ...unprojected })).toThrow(/missing GCLOUD_PROJECT/);
      }
    }
  }, LIVE_SLOTS_TIMEOUT);

  it("gives the live game and every live slot the username claim limit's client rule", () => {
    for (const args of [["slots", "live", SHA], [SHA]]) {
      const r = run(args);
      expect(r.status, r.stderr).toBe(0);
      const served = deploys(r.gcloud);
      expect(served.length).toBeGreaterThan(0);
      for (const d of served) {
        const env = envOf(d);
        expect(env.ANTWAR_USERNAME_CLAIM_LIMIT_RULE, `${args.join(" ")} ${d[2]}`).toBe("client");
      }
    }
    // Previews keep the default: no claim limit.
    for (const args of [["slots", "preview", SHA], ["preview", SHA, "dir"]]) {
      for (const d of deploys(run(args).gcloud)) expect(envOf(d).ANTWAR_USERNAME_CLAIM_LIMIT_RULE).toBeUndefined();
    }
  }, LIVE_SLOTS_TIMEOUT);
});

// The game keeps only its one immediate rollback revision warm.
describe("live path rollback tag", () => {
  it("replaces every older tag with the one rollback tag on the outgoing revision, leaving traffic on the new revision", () => {
    const r = run([SHA]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.state.services.antwar!.traffic).toEqual([
      { revisionName: "antwar-new", percent: 100 },
      { revisionName: GAME_OUT, tag: "r6b6b6b6b" },
    ]);
    // No traffic flag on the retag: traffic stays where it was moved by name.
    const retag = r.gcloud.filter((c) => c[2] === "update-traffic" && c.includes("--set-tags"));
    expect(retag).toHaveLength(1);
    expect(retag[0]!.some((x) => x.startsWith("--to-"))).toBe(false);
    expect(r.stdout).toBe("gcloud run services update-traffic antwar --account operator@example.com --project example-project --region australia-southeast1 --to-tags r6b6b6b6b=100\n");
    // The records service is never retagged by the live path, and no revision is ever deleted.
    expect(r.state.services["antwar-records"]).toEqual(startingState().services["antwar-records"]);
    expect(r.gcloud.filter((c) => c[2] === "delete")).toEqual([]);
  });

  it("stops non-zero, naming each other tag, when the retag does not take", () => {
    const r = run([SHA], { env: { IGNORE_SET_TAGS: "antwar" } });
    expect(r.status).toBe(1);
    for (const [tag, rev] of [["r0000cccc", "antwar-00007-mno"], ["r0000aaaa", "antwar-00006-pqr"], ["r0000dddd", "antwar-00005-stu"]]) {
      expect(r.stderr).toContain(`antwar: unexpected tag ${tag} on ${rev}`);
    }
    expect(r.stderr).toContain(`deployed ${SHA}, but antwar keeps a tag other than r6b6b6b6b on ${GAME_OUT}`);
  });

  it("refuses before the build when the outgoing revision cannot be read", () => {
    const r = run([SHA], { state: (s) => { delete s.revisions[GAME_OUT]; } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`refusing: cannot read the image digest and ANTWAR_CODE_VERSION of ${GAME_OUT}`);
    expect(r.gcloud.filter((c) => c[0] === "builds" || c[1] === "deploy")).toEqual([]);
  });
});

// A failed attempt's leftover revision is its service's latest created, at 0%. Every mode moves
// traffic only to the revision its own deploy created, by name, so a no-op or failed deploy never routes to it.
describe("every traffic move names the revision its deploy created", () => {
  const LFT = (svc: string) => `${svc}-00010-lft`;
  // Service svc serves out at 100% by name; its latest created and ready revision is its leftover, at 0% and untagged.
  const withLeftover = (svc: string, out: string) => (s: State) => {
    s.services[svc] = { latest: LFT(svc), created: LFT(svc), traffic: [{ revisionName: out, percent: 100 }] };
    s.revisions[out] ??= { image: `${SERVER_REPO}@sha256:${"e".repeat(64)}`, sha: "9f".repeat(20) };
    s.revisions[LFT(svc)] = { image: `${SERVER_REPO}@sha256:${"7".repeat(64)}`, sha: "7".repeat(40) };
  };
  const naming = (r: { gcloud: string[][] }, rev: string) => r.gcloud.filter((c) => c.some((w) => w.includes(rev)));
  const serving = (r: { state: State }, svc: string) => r.state.services[svc]!.traffic.filter((t) => t.percent);
  const MODES: [string, string[], string, string][] = [
    ["records", ["records", SHA], "antwar-records", RECORDS_OUT],
    ["slots live", ["slots", "live", SHA], "antwar-public-0", "antwar-public-0-00009-old"],
    ["the legacy game path", [SHA], "antwar", GAME_OUT],
  ];

  it("deploy.sh has no traffic move that follows the latest revision", () => {
    expect(readFileSync(script, "utf8")).not.toContain("--to-latest");
  });

  it("creates an absent service without --no-traffic, which gcloud refuses on create, and an existing one with it", () => {
    const existing = "antwar-preview-public-0", absent = "antwar-preview-private-0", out = `${existing}-00003-old`;
    const r = run(["slots", "preview", SHA], { listed: [existing], state: (s) => {
      s.services[existing] = { latest: out, traffic: [{ revisionName: out, percent: 100 }] };
      s.revisions[out] = { image: `${PREVIEW_REPO}@sha256:${"e".repeat(64)}`, sha: "9f".repeat(20) };
    } });
    expect(r.status, r.stderr).toBe(0);
    const deployOf = (svc: string) => deploys(r.gcloud).find((c) => c[2] === svc)!;
    expect(deployOf(existing)).toContain("--no-traffic");
    expect(deployOf(absent)).not.toContain("--no-traffic");
    expect(r.gcloud).toContainEqual(toNew(existing));
    expect(r.gcloud).toContainEqual(toNew(absent));
    expect(serving(r, existing)).toEqual([{ revisionName: `${existing}-new`, percent: 100 }]);
    expect(serving(r, absent)).toEqual([{ revisionName: `${absent}-new`, percent: 100 }]);
  });

  for (const [label, args, svc, out] of MODES) {
    it(`${label}: a no-op deploy stops, leaving traffic on ${out}, never on the leftover`, () => {
      const r = run(args, { state: withLeftover(svc, out), env: { NO_NEW_REVISION: svc } });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`stopping: ${svc} has no new revision after its deploy (latest created ${LFT(svc)}); its traffic stays on ${out}\n`);
      expect(naming(r, LFT(svc))).toEqual([]);
      expect(r.gcloud.filter((c) => c[2] === "update-traffic" && c[3] === svc)).toEqual([]);
      expect(serving(r, svc)).toEqual([{ revisionName: out, percent: 100 }]);
    });

    it(`${label}: a failed deploy stops, leaving traffic on ${out}`, () => {
      const r = run(args, { state: withLeftover(svc, out), env: { FAIL_DEPLOY: svc } });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`stopping: deploying ${svc} failed, creating no new revision; its traffic stays on ${out}\n`);
      expect(naming(r, LFT(svc))).toEqual([]);
      expect(serving(r, svc)).toEqual([{ revisionName: out, percent: 100 }]);
    });

    it(`${label}: with a leftover present, moves all traffic to its new revision by name`, () => {
      const r = run(args, { state: withLeftover(svc, out) });
      expect(r.status, r.stderr).toBe(0);
      expect(r.gcloud).toContainEqual(toNew(svc));
      expect(naming(r, LFT(svc))).toEqual([]);
      expect(serving(r, svc)).toEqual([{ revisionName: `${svc}-new`, percent: 100 }]);
    }, label === "slots live" ? LIVE_SLOTS_TIMEOUT : undefined);
  }
});

// Both paths that deploy the entry service `antwar` set ANTWAR_LOAD_BALANCER_ADDRESS to
// every antwars.ai forwarding-rule address, which src/server/clientSource.ts looks past to the
// client, and refuse before any gate, build or deploy when it resolves empty or invalid. No
// address ever reaches the output.
describe("load balancer addresses", () => {
  const LIVE_PATHS: readonly (readonly string[])[] = [[SHA], ["all", SHA]];
  // Every address the fakes can list, which must never be printed.
  const ADDRESSES = ["192.0.2.10", "2001:db8::a", "198.51.100.7", "203.0.113.", "fe80::1"];
  const printed = (r: { stdout: string; stderr: string }) => ADDRESSES.filter((a) => (r.stdout + r.stderr).includes(a));
  // antwar's variables before ANTWAR_LOAD_BALANCER_ADDRESS, as the live path and `all` gave them, with the client-source
  // claim rule.
  const before = envOf(["--update-env-vars", `GCLOUD_PROJECT=example-project,ANTWAR_RECORD_INPUT_BUCKET=example-record-inputs,ANTWAR_CODE_VERSION=${SHA},ANTWAR_PUBLIC_SLOTS=8,ANTWAR_PRIVATE_SLOTS=8,ANTWAR_SLOT_URL_TEMPLATE=${slotUrlTemplate("antwar-")},${CLIENT_SOURCE_ENV}`]);
  const gameDeploy = (r: { gcloud: string[][] }) => deploys(r.gcloud).find((c) => c[2] === "antwar")!;

  it("the live path adds only ANTWAR_LOAD_BALANCER_ADDRESS to antwar's variables, read before the build, and prints no address", () => {
    const r = run([SHA]);
    expect(r.status, r.stderr).toBe(0);
    expect(envOf(gameDeploy(r))).toEqual({ ...before, ANTWAR_LOAD_BALANCER_ADDRESS: LB });
    expect(r.gcloud.findIndex((c) => c[0] === "compute")).toBeLessThan(r.gcloud.findIndex((c) => c[0] === "builds"));
    expect(printed(r)).toEqual([]);
  });

  it("two IPv4 rules on one address give that one address", () => {
    const r = run([SHA], { env: { FAKE_RULES: JSON.stringify(RULES.slice(0, 2)) } });
    expect(r.status, r.stderr).toBe(0);
    expect(envOf(gameDeploy(r)).ANTWAR_LOAD_BALANCER_ADDRESS).toBe("192.0.2.10");
  });

  const refusals: [string, string][] = [
    ["the rule list cannot be read", "FAIL"],
    ["the rule list is not JSON", "not json"],
    ["there is no rule", "[]"],
    ["every rule is outside the antwar-domain- namespace", JSON.stringify([RULES[3]])],
    ["a rule has no address", JSON.stringify([RULES[0], { name: "antwar-domain-http" }])],
    ["an address is invalid", JSON.stringify([RULES[0], { name: "antwar-domain-http", IPAddress: "203.0.113.300" }])],
    ["an address is a range", JSON.stringify([RULES[0], { name: "antwar-domain-http", IPAddress: "203.0.113.0/24" }])],
    ["an IPv6 address is scoped", JSON.stringify([RULES[0], { name: "antwar-domain-http", IPAddress: "fe80::1%eth0" }])],
  ];
  for (const args of LIVE_PATHS) {
    for (const [why, rules] of refusals) {
      it(`${args.length === 1 ? "the live path" : "all"} refuses, naming the variable and no address, when ${why}`, () => {
        const r = run(args, { env: { FAKE_RULES: rules } });
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/refusing: ANTWAR_LOAD_BALANCER_ADDRESS (resolves empty|resolves invalid|cannot be read)/);
        // Nothing past the read: no gate, image lookup, build or deploy.
        expect(r.gcloud.filter((c) => ["builds", "artifacts", "storage"].includes(c[0]!) || c[1] === "deploy" || c[2] === "update-traffic")).toEqual([]);
        expect(r.calls.filter((c) => c[0] === "curl" || c[0] === "probe")).toEqual([]);
        expect(printed(r)).toEqual([]);
      });
    }
  }

  // One test per mode, so each stays well inside the default timeout.
  for (const args of [["preview", SHA, "dir"], ["preview-remove", "dir"], ["slots", "preview", SHA], ["slots-remove", "preview"], ["records", SHA]]) {
    it(`${args[0]} does not read the forwarding rules`, () => {
      const r = run(args, { listed: ["antwar-preview-public-0", "antwar-preview-private-0"] });
      expect(r.status, `${args.join(" ")}: ${r.stderr}`).toBe(0);
      expect(r.gcloud.filter((c) => c[0] === "compute"), args.join(" ")).toEqual([]);
    });
  }
});

// One command brings the record service, the 16 live slots and the game to one commit.
describe.concurrent("all", () => {
  const SLOTS = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => `public-${n}`).concat([0, 1, 2, 3, 4, 5, 6, 7].map((n) => `private-${n}`));
  const SERVICES = ["antwar-records", ...SLOTS.map((s) => `antwar-${s}`), "antwar"];
  const SLOT_OUT_SHA = "9f".repeat(20);
  const slotOut = (svc: string) => `${svc}-00009-old`;
  const IMAGE = `${SERVER_REPO}@${DIGEST}`;
  const KEY = "ANTWAR_PRIVATE_REPLAY_KEY=antwar-private-replay-key:1";
  const TOKEN = "ANTWAR_OPERATOR_TOKEN=ANTWAR_OPERATOR_TOKEN:latest";
  // The swap checks' probes add about half again to a full run of fakes.
  const TIMEOUT = 300_000;
  // A production-like state: every slot serving one revision, an older one still tagged.
  const live = (curl: CurlState = {}, edit?: (s: State) => void) => (s: State) => {
    for (const slot of SLOTS) {
      const svc = `antwar-${slot}`;
      s.services[svc] = { latest: slotOut(svc), traffic: [
        { revisionName: slotOut(svc), percent: 100, latestRevision: true },
        { revisionName: `${svc}-00008-tag`, tag: "r0000eeee" },
      ] };
      s.revisions[slotOut(svc)] = { image: `${SERVER_REPO}@sha256:${"e".repeat(64)}`, sha: SLOT_OUT_SHA,
        env: ["ANTWAR_PRIVATE_REPLAY_KEY", ...(slot.startsWith("public") ? ["ANTWAR_OPERATOR_TOKEN"] : [])] };
    }
    s.revisions[GAME_OUT]!.cpu = "2";
    s.revisions[GAME_OUT]!.env = ["ANTWAR_PRIVATE_REPLAY_KEY"];
    s.curl = curl;
    edit?.(s);
  };
  // A run mark: running/<sha>/<run>/<revision>, the run being <UTC start>-<first 8 of sha>.
  const MARK = (revision: string, sha = SHA) => new RegExp(`^running/${sha}/\\d{8}T\\d{6}Z-${sha.slice(0, 8)}/${revision}$`);
  const isMark = (o: string) => /^running\/[0-9a-f]{40}\/[^/]+\/[^/]+$/.test(o);
  const indexOf = (calls: string[][], match: (c: string[]) => boolean) => calls.findIndex(match);
  // After call i, only reads of the services (the FAILED status names what each serves).
  const onlyReadsAfter = (r: { calls: string[][] }, i: number) => i >= 0
    && r.calls.slice(i + 1).every((c) => c[0] === "gcloud" && c[1] === "run" && c[2] === "services" && c[3] === "describe");
  const deployed = (r: { gcloud: string[][] }) => deploys(r.gcloud).map((c) => c[2]);
  // The minute-long waits between rounds (the swap checks sleep 5 s between probes).
  const roundSleeps = (r: { calls: string[][] }) => r.calls.filter((c) => c[0] === "sleep" && c[1] !== "5");

  it("deploys records, the 16 slots and the game from one image, and prints each new revision", async () => {
    const r = await runAsync(["all", SHA], { state: live(), env: { ANTWAR_SWAP_STABLE: "" } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe(SERVICES.map((s) => `${s} ${s}-new\n`).join(""));
    expect(r.stderr).toContain(` done ${SHA} all 18 services, domain comparison passed\n`);
    expect(deployed(r)).toEqual(SERVICES);
    // The domain comparison runs once, last, with exactly these arguments, and its pass is reported.
    expect(r.calls.filter((c) => c[0] === "probe")).toEqual([["probe", "domain", "https://antwars.ai", CONFIG.GAME_SERVICE_URL, "720"]]);
    expect(r.calls.findIndex((c) => c[0] === "probe")).toBe(r.calls.length - 1);
    expect(r.stderr).toContain(" domain comparison passed\n");
    // The probe's packages are installed once, in the checkout, before any build, deploy or traffic move.
    const installs = r.calls.filter((c) => c[0] === "npm");
    expect(installs).toEqual([["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"]]);
    const firstChange = indexOf(r.calls, (c) => c[0] === "gcloud" && (["builds", "artifacts"].includes(c[1]!) || c[2] === "deploy" || c[3] === "update-traffic"));
    expect(indexOf(r.calls, (c) => c[0] === "npm")).toBeGreaterThanOrEqual(0);
    expect(indexOf(r.calls, (c) => c[0] === "npm")).toBeLessThan(firstChange);
    // Every slot and the game reach the config file's project for their shared store; the
    // game's namespace is set outside the script and kept by --update-env-vars.
    for (const d of deploys(r.gcloud).slice(1)) {
      const env = envOf(d);
      expect(env.GCLOUD_PROJECT, d[2]).toBe(CONFIG.PROJECT);
      expect(await storeTarget({ ANTWAR_STORE_NAMESPACE: "live", ...env }), d[2]).toBe(storeDocument("live"));
    }
    for (const d of deploys(r.gcloud)) expect(d.slice(3, 5)).toEqual(["--image", IMAGE]);

    // Records and every slot restate the shape their own modes deploy, slots adding the operator token on public ones.
    const records = run(["records", SHA]);
    expect(deploys(r.gcloud)[0]).toEqual(deploys(records.gcloud)[0]);
    const counts = "ANTWAR_PUBLIC_SLOTS=8,ANTWAR_PRIVATE_SLOTS=8";
    const liveEnv = `,ANTWAR_REPLAY_BUCKET=example-replays,ANTWAR_RECORD_INPUT_BUCKET=example-record-inputs,ANTWAR_CODE_VERSION=${SHA},${CLIENT_SOURCE_ENV}`;
    for (const [i, slot] of SLOTS.entries()) {
      const expected = last(slotDeploy(`antwar-${slot}`, slot, "live", SERVER_REPO, counts, liveEnv));
      if (slot.startsWith("public")) expected[expected.indexOf(KEY)] = `${KEY},${TOKEN}`;
      expect(deploys(r.gcloud)[i + 1]).toEqual(noTraffic(expected));
    }

    // The game: 2 vCPU with the private replay key, no traffic until Ready, then all of it.
    // The load balancer's addresses are read once, before any gate, build or deploy, and never printed.
    expect(r.gcloud.filter((c) => c[0] === "compute")).toEqual([RULES_LIST]);
    expect(r.calls.findIndex((c) => c[0] === "gcloud" && c[1] === "compute")).toBeLessThan(r.calls.findIndex((c) => c[0] === "curl"));
    expect(r.gcloud.findIndex((c) => c[0] === "compute")).toBeLessThan(r.gcloud.findIndex((c) => c[0] === "artifacts"));
    for (const address of ["192.0.2.10", "2001:db8::a"]) expect(r.stdout + r.stderr).not.toContain(address);
    expect(deploys(r.gcloud)[17]).toEqual(["run", "deploy", "antwar", "--image", IMAGE,
      "--update-env-vars", `${GAME_ENV_FLAG};${CLIENT_SOURCE_ENV}`,
      "--update-secrets", KEY,
      "--service-account", "antwar-run@example-project.iam.gserviceaccount.com", "--min-instances", "1", "--max-instances", "1",
      "--max", "1", "--no-cpu-throttling", "--cpu", "2", "--memory", "2Gi", "--timeout", "3600", "--concurrency", "1000",
      "--ingress", "all", "--no-invoker-iam-check", "--labels", `app=antwar,commit=${SHA}`, "--no-traffic", ...ACCOUNT, ...REGION]);
    const gameDeploy = indexOf(r.gcloud, (c) => c[1] === "deploy" && c[2] === "antwar");
    const gameTraffic = indexOf(r.gcloud, (c) => c[2] === "update-traffic" && c[3] === "antwar" && c[4] === "--to-revisions");
    expect(r.gcloud[gameTraffic]![5]).toBe("antwar-new=100");
    expect(gameTraffic).toBeGreaterThan(gameDeploy);
    expect(r.calls.filter((c) => c[0] === "curl" && c.includes("https://antwars.ai/"))).toHaveLength(1);

    // No traffic move ever names "latest". Every service's new revision is recorded in this
    // run's mark straight after its deploy creates it, then all traffic moves to it by name.
    expect(r.gcloud.filter((c) => c.includes("--to-latest"))).toEqual([]);
    for (const svc of SERVICES) {
      const deploy = indexOf(r.calls, (c) => c[0] === "gcloud" && c[2] === "deploy" && c[3] === svc);
      expect(r.calls[deploy + 1]!.slice(0, 5), svc).toEqual(["gcloud", "run", "services", "describe", svc]);
      expect(r.calls[deploy + 2]!.slice(0, 4), svc).toEqual(["gcloud", "storage", "cp", "-"]);
      expect(r.calls[deploy + 2]![4]!.replace(BUCKET, ""), svc).toMatch(MARK(`${svc}-new`));
      const move = indexOf(r.calls, (c) => c[0] === "gcloud" && c[3] === "update-traffic" && c[4] === svc && c[5] === "--to-revisions");
      expect(r.calls[move]![6], svc).toBe(`${svc}-new=100`);
      expect(move, svc).toBeGreaterThan(deploy + 2);
    }
    expect(r.state.bucket!.objects.filter(isMark).sort()).toEqual(expect.arrayContaining(SERVICES.map((svc) => expect.stringMatching(MARK(`${svc}-new`)))));
    expect(r.state.bucket!.objects.filter(isMark)).toHaveLength(18);

    // The swap check: only once all a slot's traffic is on its new revision, its instance record, /ready and,
    // on a public slot only, an unauthenticated stop, on 3 consecutive probes 5 s apart.
    for (const slot of SLOTS) {
      const svc = `antwar-${slot}`;
      const move = indexOf(r.calls, (c) => c[0] === "gcloud" && c[3] === "update-traffic" && c[4] === svc && c[5] === "--to-revisions");
      const probes = r.calls.map((c, i) => [c, i] as const).filter(([c]) => c[0] === "curl" && (c.at(-1) === `${url(svc)}/ready`
        || c.at(-1) === `${url(svc)}/operator/stop` || c.at(-1) === `${FS_LIVE}/instances/${slot}`));
      expect(probes.map(([c]) => c.at(-1)!.split("/").pop()), slot).toEqual(Array(3).fill(slot.startsWith("public") ? ["ready", slot, "stop"] : ["ready", slot]).flat());
      for (const [, i] of probes) expect(i, slot).toBeGreaterThan(move);
      expect(r.stderr).toContain(` ${svc} swap check 3: ${svc}-new holds slot ${slot} (3 of 3 in a row)\n`);
    }
    // The status file: DONE, naming the run and each service's new revision.
    expect(r.status).toBe(0);
    expect(r.statusFile).toMatch(new RegExp(`^DONE\nrun: \\d{8}T\\d{6}Z-${SHA.slice(0, 8)}\nsha: ${SHA}\nfinished: \\S+Z\nserving:\n`));
    expect(r.statusFile).toContain(SERVICES.map((svc) => `  ${svc} ${svc}-new\n`).join(""));
    expect(r.stderr).toContain(` deploy status DONE written to ${r.dir}/antwar-deploy-status\n`);

    // One rollback each: the outgoing revision, tagged on the game, untagged on records and
    // every slot, each slot's restored by revision name.
    expect(r.state.services["antwar-records"]!.traffic).toEqual([{ revisionName: "antwar-records-new", percent: 100 }]);
    expect(r.stderr).toContain(`records rollback: revision ${RECORDS_OUT}, untagged: ${script} records-rollback ${RECORDS_OUT_SHA} ${RECORDS_OUT_DIGEST}`);
    for (const slot of SLOTS) {
      const svc = `antwar-${slot}`;
      expect(r.state.services[svc]!.traffic, svc).toEqual([{ revisionName: `${svc}-new`, percent: 100 }]);
      expect(r.gcloud.filter((c) => c[2] === "update-traffic" && c[3] === svc && c.includes("--set-tags")), svc).toEqual([]);
      expect(r.gcloud, svc).toContainEqual(["run", "services", "update-traffic", svc, "--clear-tags", ...ACCOUNT, ...REGION]);
      expect(r.stderr).toContain(` ${svc} rollback: gcloud run services update-traffic ${svc} --account operator@example.com --project example-project --region australia-southeast1 --to-revisions ${slotOut(svc)}=100\n`);
    }
    expect(r.stderr.match(/ rollback: gcloud run services update-traffic antwar-(public|private)-\d --.* --to-revisions /g)).toHaveLength(16);
    expect(r.state.services.antwar!.traffic).toEqual([{ revisionName: "antwar-new", percent: 100 }, { revisionName: GAME_OUT, tag: "r6b6b6b6b" }]);
    expect(r.stderr).toContain(" antwar rollback: gcloud run services update-traffic antwar --account operator@example.com --project example-project --region australia-southeast1 --to-tags r6b6b6b6b=100\n");
    expect(r.gcloud.filter((c) => c[0] === "run" && (c[2] === "delete" || c[2] === "list"))).toEqual([]);

    // Nothing was busy, so nothing waited beyond the swap checks' probe interval; the bearer never reached a command line.
    expect(r.calls.filter((c) => c[0] === "sleep" && c[1] !== "5")).toEqual([]);
    expect(r.calls.flat().join(" ")).not.toContain("fake-token");
    expect(r.calls.flat()).not.toContain("<prompts enabled>");
    // Every lobby page was read: the second page is asked for by its token.
    expect(r.calls.some((c) => c[0] === "curl" && c.includes("pageToken=page/2+"))).toBe(true);
  }, TIMEOUT);

  it("a failed package install refuses before any change, so the domain comparison never runs short of its packages", () => {
    const r = run(["all", SHA], { state: live(), env: { FAKE_NPM_FAIL: "1" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("refusing: npm ci failed in the checkout, so the domain comparison could not run; nothing was changed\n");
    expect(r.calls.filter((c) => c[0] === "npm")).toHaveLength(1);
    // Nothing past the install but the FAILED status's reads: no gate, build, deploy, traffic move or probe.
    expect(onlyReadsAfter(r, indexOf(r.calls, (c) => c[0] === "npm"))).toBe(true);
    expect(r.statusFile).toMatch(/^FAILED\n/);
  }, TIMEOUT);

  it("domain comparison: a skip is reported as a skip, never as a pass", async () => {
    const r = await runAsync(["all", SHA], { state: live(), probe: "skip" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(SKIP_LINE);
    expect(r.stderr).toContain(" domain comparison SKIPPED, not a pass: no public lobby in both catalogs\n");
    expect(r.stderr).toContain(` done ${SHA} all 18 services, domain comparison SKIPPED, not a pass`);
    expect(r.stderr).not.toContain("domain comparison passed");
  }, TIMEOUT);

  it("domain comparison: a failure ends the deploy non-zero, visibly, with no rollback", async () => {
    const r = await runAsync(["all", SHA], { state: live(), probe: "fail" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`stopping: domain comparison of https://antwars.ai and ${CONFIG.GAME_SERVICE_URL} failed (probe exit 1, above); nothing was rolled back, every service serves ${SHA}\n`);
    expect(r.stderr).not.toContain(" done ");
    // Nothing but the FAILED status's reads runs after the probe, and every service keeps its new revision.
    const probe = r.calls.findIndex((c) => c[0] === "probe");
    expect(onlyReadsAfter(r, probe)).toBe(true);
    expect(r.statusFile).toMatch(/^FAILED\n/);
    expect(r.statusFile).toContain("step: domain comparison\nslot: none\n");
    expect(r.stdout).toBe(SERVICES.map((s) => `${s} ${s}-new\n`).join(""));
    for (const svc of SERVICES) expect(r.state.services[svc]!.traffic.filter((t) => t.percent), svc).toEqual([expect.objectContaining({ revisionName: `${svc}-new`, percent: 100 })]);
  }, TIMEOUT);

  it("domain comparison: an exit 0 with no comparison result is a failure, not a pass", async () => {
    const r = await runAsync(["all", SHA], { state: live(), probe: "silent" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`stopping: domain comparison of https://antwars.ai and ${CONFIG.GAME_SERVICE_URL} reported no result (above); nothing was rolled back, every service serves ${SHA}\n`);
    expect(onlyReadsAfter(r, r.calls.findIndex((c) => c[0] === "probe"))).toBe(true);
  }, TIMEOUT);

  it("domain comparison: probe.mjs itself refuses a service host on the site's own origin before any request", async () => {
    const r = await runAsync(["all", SHA], { state: live(), probe: "real", config: { GAME_SERVICE_URL: "https://antwars.ai" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^\S+ RESULT probe failed two distinct credential-free HTTPS origins required$/m);
    expect(r.stderr).toContain("stopping: domain comparison of https://antwars.ai and https://antwars.ai failed (probe exit 1, above); nothing was rolled back");
  }, TIMEOUT);

  it("waits for the queue before records, retries a held or playing slot, and waits for an open lobby before the game", async () => {
    const r = await runAsync(["all", SHA], { state: live({ queue: 1, holders: { "public-3": 1 }, playing: { "private-1": 1 }, lobbyAtGame: 1 }) });
    expect(r.status, r.stderr).toBe(0);
    const later = ["antwar-public-3", "antwar-private-1"];
    expect(deployed(r)).toEqual([...SERVICES.slice(0, 17).filter((s) => !later.includes(s)), ...later, "antwar"]);
    expect(r.stderr).toContain("antwar-records waits: queue entries waiting in ranked-1v1");
    expect(r.stderr).toContain("antwar-public-3 waits: slots/public-3 answers 200 (held)");
    expect(r.stderr).toContain('antwar-private-1 waits: status {"kind":"playing","match":3}');
    expect(r.stderr).toContain("antwar waits: lobbies open: lobby-7f3a:holding");
    expect(roundSleeps(r)).toEqual([["sleep", "60"], ["sleep", "60"], ["sleep", "60"]]);
    expect(r.stdout.trim().split("\n")).toHaveLength(18);
  }, TIMEOUT);

  it("stops naming a slot still busy at the round limit, never deploying it or the game", async () => {
    const r = await runAsync(["all", SHA], { state: live({ holders: { "public-5": 1e9 } }), env: { ANTWAR_DEPLOY_ROUNDS: "2" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("stopping: still busy after 2 rounds: antwar-public-5");
    expect(deployed(r)).toEqual(SERVICES.slice(0, 17).filter((s) => s !== "antwar-public-5"));
    expect(r.stdout).toBe("");
    expect(r.stderr).not.toContain(" done ");
  }, TIMEOUT);

  it("stops naming the open lobbies when the game stays blocked, leaving the game untouched", async () => {
    const r = await runAsync(["all", SHA], { state: live({ lobbyAtGame: 1e9 }), env: { ANTWAR_DEPLOY_ROUNDS: "2" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("stopping: antwar is still blocked after 2 rounds: lobbies open: lobby-7f3a:holding");
    expect(deployed(r)).not.toContain("antwar");
    expect(r.state.services.antwar!.traffic[0]).toEqual({ revisionName: GAME_OUT, percent: 100, latestRevision: true });
  }, TIMEOUT);

  it("changes nothing while a queue entry waits or Firestore cannot be read", async () => {
    const queued = await runAsync(["all", SHA], { state: live({ queue: 1e9 }), env: { ANTWAR_DEPLOY_ROUNDS: "1" } });
    expect(queued.status).toBe(1);
    expect(queued.stderr).toContain("stopping: antwar-records is still blocked after 1 rounds: queue entries waiting in ranked-1v1");
    expect(deploys(queued.gcloud)).toEqual([]);
    expect(queued.gcloud.filter((c) => c[2] === "update-traffic")).toEqual([]);
    // No access token: every Firestore read fails, which counts as busy.
    const unread = await runAsync(["all", SHA], { state: live(), env: { ANTWAR_DEPLOY_ROUNDS: "1", FAKE_NO_TOKEN: "1" } });
    expect(unread.status).toBe(1);
    expect(unread.stderr).toContain("antwar-records is still blocked after 1 rounds: no Firestore access token");
    expect(deploys(unread.gcloud)).toEqual([]);
  }, TIMEOUT);

  // Expiry is derived from the clock and never written (src/lobby/lobbies.ts isExpired),
  // so an expired lobby stays stored open or waiting and must not hold the deploy.
  it("does not wait for an expired player-created lobby, seated or not", async () => {
    const old = LOBBY_TTL_MS + 60_000;
    const r = await runAsync(["all", SHA], { state: live({ lobbies: [
      { id: "lobby-0a3c", state: "open", ageMs: old, seats: 1 },
      { id: "lobby-9b1e", state: "waiting", ageMs: old, seats: 2 },
    ] }), env: { ANTWAR_DEPLOY_ROUNDS: "1" } });
    expect(r.status, r.stderr).toBe(0);
    expect(deployed(r)).toEqual(SERVICES);
    expect(r.stderr).not.toContain("lobbies open");
    expect(roundSleeps(r)).toEqual([]);
  }, TIMEOUT);

  it("still waits for a lobby not yet expired and for a queue-made lobby, which never expires", async () => {
    const r = await runAsync(["all", SHA], { state: live({ lobbies: [
      { id: "lobby-young", state: "open", ageMs: LOBBY_TTL_MS - 5 * 60_000, seats: 1 },
      { id: "lobby-queue", state: "open", ageMs: LOBBY_TTL_MS + 60_000, mode: "ranked-1v1", seats: 2 },
    ] }), env: { ANTWAR_DEPLOY_ROUNDS: "1" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("stopping: antwar-records is still blocked after 1 rounds: lobbies open: lobby-young:open,lobby-queue:open");
    expect(deploys(r.gcloud)).toEqual([]);
  }, TIMEOUT);

  it("stops after a public slot accepts an unauthenticated stop", async () => {
    const r = await runAsync(["all", SHA], { state: live({ stop: { "public-0": 200 } }) });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("stopping: antwar-public-0 answers an unauthenticated POST /operator/stop with 200, not 401");
    expect(deployed(r)).toEqual(["antwar-records", "antwar-public-0"]);
  }, TIMEOUT);

  // A tagged old slot revision can start an instance that takes the slot.
  it("stops naming a slot and its leftover tag when the slot's tags do not clear, never reaching the game", async () => {
    const r = await runAsync(["all", SHA], { state: live(), env: { KEEP_TAGS: "antwar-public-0" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("antwar-public-0: unexpected tag r0000eeee on antwar-public-0-00008-tag");
    expect(r.stderr).toContain("stopping: antwar-public-0 keeps a tag or traffic other than its one rollback (above)");
    expect(deployed(r)).toEqual(["antwar-records", "antwar-public-0"]);
    expect(r.stdout).toBe("");
  }, TIMEOUT);

  it("reverts the game's traffic and stops when the site does not answer 200", async () => {
    const r = await runAsync(["all", SHA], { state: live({ site: 503 }) });
    expect(r.status).toBe(1);
    expect(r.calls.filter((c) => c[0] === "curl" && c.includes("https://antwars.ai/"))).toHaveLength(30);
    expect(r.stderr).toContain(`stopping: https://antwars.ai/ answered 503, not 200, within 5 minutes of antwar-new serving; antwar traffic was reverted to ${GAME_OUT}`);
    expect(r.gcloud.filter((c) => c[2] === "update-traffic" && c[3] === "antwar").map((c) => c[5])).toEqual(["antwar-new=100", `${GAME_OUT}=100`]);
    expect(r.state.services.antwar!.traffic.filter((t) => t.percent)).toEqual([{ revisionName: GAME_OUT, percent: 100 }]);
    expect(r.stdout).toBe("");
  }, TIMEOUT);

  it("never moves traffic to a game revision that is not Ready", async () => {
    const r = await runAsync(["all", SHA], { state: live(), env: { NOT_READY: "antwar" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`stopping: antwar antwar-new is not Ready; its traffic stays on ${GAME_OUT}`);
    expect(r.gcloud.filter((c) => c[2] === "update-traffic" && c[3] === "antwar")).toEqual([]);
  }, TIMEOUT);

  it("refuses to report done, naming the service, when one serves another code version", async () => {
    const r = await runAsync(["all", SHA], { state: live(), env: { WRONG_VERSION: "antwar-private-6" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`mismatch: antwar-private-6 antwar-private-6-new runs ANTWAR_CODE_VERSION ${"f".repeat(40)}, not ${SHA}`);
    expect(r.stderr).toContain(`stopping: not done: the services above do not all serve ${SHA}`);
    expect(r.stderr.match(/mismatch: /g)).toHaveLength(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).not.toContain(" done ");
  }, TIMEOUT);

  it("stops, naming the service, when its traffic does not move to the new revision by name", async () => {
    const r = await runAsync(["all", SHA], { state: live(), ignoreTraffic: true });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`stopping: antwar-records serves ${RECORDS_OUT} at 100%, not its new revision antwar-records-new, after its traffic move`);
    expect(r.gcloud.filter((c) => c[2] === "update-traffic")).toEqual([["run", "services", "update-traffic", "antwar-records", "--to-revisions", "antwar-records-new=100", ...ACCOUNT, ...REGION]]);
    expect(deployed(r)).toEqual(["antwar-records"]);
  }, TIMEOUT);

  it("refuses before any build or change when a service cannot be rolled back, or the commit or arguments are wrong", async () => {
    const split = await runAsync(["all", SHA], { state: live({}, (s) => { s.services["antwar-public-2"]!.created = "antwar-public-2-00010-new"; }) });
    expect(split.status).toBe(1);
    expect(split.stderr).toContain("refusing: antwar-public-2 does not serve exactly its latest created revision antwar-public-2-00010-new at 100%");
    expect(split.gcloud.filter((c) => c[0] === "builds" || c[1] === "deploy" || c[2] === "update-traffic")).toEqual([]);

    const unreadable = await runAsync(["all", SHA], { state: live({}, (s) => { delete s.revisions[GAME_OUT]; }), imageExists: false });
    expect(unreadable.status).toBe(1);
    expect(unreadable.stderr).toContain(`refusing: cannot read the image digest and ANTWAR_CODE_VERSION of ${GAME_OUT}`);
    expect(unreadable.gcloud.filter((c) => c[0] === "builds" || c[1] === "deploy")).toEqual([]);

    const offMain = await runAsync(["all", SHA], { state: live(), onMain: false });
    expect(offMain.status).toBe(1);
    expect(offMain.stderr).toContain(`refusing: ${SHA} is not a commit on origin/main`);
    expect(offMain.gcloud.filter((c) => !(c[1] === "services" && c[2] === "describe"))).toEqual([]);

    for (const args of [["all"], ["all", "abc"], ["all", SHA, "extra"]]) {
      const r = await runAsync(args, { state: live() });
      expect(r.status).toBe(2);
      expect(r.gcloud).toEqual([]);
    }
  }, TIMEOUT);

  // A rolling deploy, taken only when every outgoing build carries the slot mark
  // and the records overlap signal. The fake git passes the ancestry check for SUPPORTED builds.
  const SUPPORTED = [RECORDS_OUT_SHA, GAME_OUT_SHA, SLOT_OUT_SHA].join(" ");
  const BUCKET = "gs://example-record-inputs/";
  const FS_LIVE = "https://firestore.googleapis.com/v1/projects/example-project/databases/(default)/documents/namespaces/live";
  const OLD_TAG = `r${RECORDS_OUT_SHA.slice(0, 8)}`;
  // The signal's names as src/records/input-store.ts declares them.
  const RUN_OLD = runningBuildName(RECORDS_OUT_SHA), RUN_NEW = runningBuildName(SHA);
  const curlTo = (c: string[]) => c.at(-1) ?? "";
  const method = (c: string[]) => (c.includes("-X") ? c[c.indexOf("-X") + 1] : "GET");
  // Index in r.calls of the first call matching.
  const at = (r: { calls: string[][] }, match: (c: string[]) => boolean) => r.calls.findIndex(match);
  const lastAt = (r: { calls: string[][] }, match: (c: string[]) => boolean) => r.calls.map((c, i) => (match(c) ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
  const mark = (m: string, slot: string) => (c: string[]) => c[0] === "curl" && method(c) === m && curlTo(c) === `${FS_LIVE}/${withheldDoc(slot)}`;
  const storage = (verb: string, object: string) => (c: string[]) => c[0] === "gcloud" && c[1] === "storage" && c[2] === verb && c.includes(BUCKET + object);
  // Running/<commit> is written by exact name with one JSON-API media upload.
  const UPLOAD = "https://storage.googleapis.com/upload/storage/v1/b/example-record-inputs/o?uploadType=media&name=";
  const upload = (object: string) => (c: string[]) => c[0] === "curl" && method(c) === "POST" && curlTo(c) === UPLOAD + encodeURIComponent(object);
  const isUpload = (c: string[]) => c[0] === "curl" && curlTo(c).startsWith(UPLOAD);
  const gcloudAt = (svc: string, ...words: string[]) => (c: string[]) => c[0] === "gcloud" && c[2] === "deploy" && c[3] === svc && words.length === 0
    || c[0] === "gcloud" && c[3] === "update-traffic" && c[4] === svc && words.every((w) => c.includes(w)) && words.length > 0;
  const withBucket = (bucket: BucketState) => (s: State) => { s.bucket = bucket; };
  const clearCommand = (slot: string) => `printf 'Authorization: Bearer %s\\n' "$(gcloud auth print-access-token --account operator@example.com)" | curl -H @- -X DELETE '${FS_LIVE}/${withheldDoc(slot)}'`;

  it("rolling: waits on no queue entry or lobby, withholds every slot before the first slot swap and releases each after its own", async () => {
    const r = await runAsync(["all", SHA], { state: live({ queue: 1e9, lobbyAtGame: 1e9, lobbies: [
      { id: "lobby-young", state: "open", ageMs: 60_000, seats: 1 },
      { id: "lobby-queue", state: "waiting", ageMs: LOBBY_TTL_MS + 60_000, mode: "ranked-1v1", seats: 2 },
    ] }), env: { SUPPORTED, ANTWAR_DEPLOY_ROUNDS: "1" } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain(" rolling deploy: every outgoing build contains 46d6c91bcaf385019fc8477646047c85a3263804 e6f22591cd2a40ddcccb084b2c11f49745e12398");
    expect(deployed(r)).toEqual(SERVICES);
    expect(r.stdout).toBe(SERVICES.map((svc) => `${svc} ${svc}-new\n`).join(""));
    expect(roundSleeps(r)).toEqual([]);
    // The queue and the lobbies are never read or written; the only Firestore writes are the marks,
    // and the only other curl writes the two running/<commit> uploads.
    expect(r.calls.filter((c) => c[0] === "curl" && /\/(queueWaiting|lobbies|queueEntries|queues)/.test(curlTo(c)))).toEqual([]);
    expect(r.calls.filter((c) => c[0] === "curl" && c.includes("-X") && !curlTo(c).startsWith(`${FS_LIVE}/withheld/`)
      && !curlTo(c).endsWith("/operator/stop") && !upload(RUN_OLD)(c) && !upload(RUN_NEW)(c))).toEqual([]);
    const firstSlotDeploy = at(r, gcloudAt("antwar-public-0"));
    for (const slot of SLOTS) {
      const svc = `antwar-${slot}`;
      expect(r.calls.filter(mark("PATCH", slot)), slot).toHaveLength(1);
      expect(r.calls.filter(mark("DELETE", slot)), slot).toHaveLength(1);
      expect(at(r, mark("PATCH", slot)), slot).toBeLessThan(firstSlotDeploy);
      // Released only once swapped, checked and down to its one rollback.
      expect(at(r, mark("DELETE", slot)), slot).toBeGreaterThan(at(r, gcloudAt(svc, "--clear-tags")));
      expect(at(r, mark("DELETE", slot)), slot).toBeGreaterThan(lastAt(r, (c) => c[0] === "curl" && curlTo(c).startsWith(url(svc))));
    }
    expect(r.state.curl!.withheld).toEqual([]);
    expect(r.stderr).not.toContain("left withheld");
  }, TIMEOUT);

  it("rolling: a slot holding or playing a match is retried in a later round, still withheld, and swapped after its match ends", async () => {
    const r = await runAsync(["all", SHA], { state: live({ holders: { "public-3": 1 }, playing: { "private-1": 2 } }), env: { SUPPORTED } });
    expect(r.status, r.stderr).toBe(0);
    expect(deployed(r)).toEqual([...SERVICES.slice(0, 17).filter((svc) => svc !== "antwar-public-3" && svc !== "antwar-private-1"),
      "antwar-public-3", "antwar-private-1", "antwar"]);
    expect(r.stderr).toContain("antwar-public-3 waits: slots/public-3 answers 200 (held)");
    expect(r.stderr).toContain('antwar-private-1 waits: status {"kind":"playing","match":3}');
    expect(roundSleeps(r)).toEqual([["sleep", "60"], ["sleep", "60"]]);
    for (const slot of ["public-3", "private-1"]) {
      expect(r.calls.filter(mark("PATCH", slot)), slot).toHaveLength(1);
      // Its mark stays across the rounds until its own swap.
      expect(at(r, mark("DELETE", slot)), slot).toBeGreaterThan(at(r, gcloudAt(`antwar-${slot}`)));
    }
    expect(r.state.curl!.withheld).toEqual([]);
  }, TIMEOUT);

  it("rolling: keeps the outgoing records builder running beside the new one, declared, until its inputs are built, then ends with one builder", async () => {
    const OLD = "2026-01-01T07-50-00-000Z-41", DONE = "2026-01-01T06-10-00-000Z-12", LATE = "2026-01-01T08-20-00-000Z-77";
    const GAVE_UP = "2026-01-01T06-40-00-000Z-55";
    const listed = [
      // An outgoing-build match's input, built on the third listing after the snapshot.
      { name: `${OLD}.input`, shows: 3 },
      // Inputs the outgoing and the new builder have given up on (the last marker of MAX_FAILURES,
      // named as src/records/input-store.ts names it), and one the new build wrote after the snapshot.
      { name: `${DONE}.input`, shows: 1e9 }, { name: markerName(DONE, MAX_FAILURES, RECORDS_OUT_SHA), shows: 1e9 },
      { name: `${GAVE_UP}.input`, shows: 1e9 }, { name: markerName(GAVE_UP, MAX_FAILURES, SHA), shows: 1e9 },
      { name: `${LATE}.input`, shows: 1e9, after: 1 },
    ];
    // Every listed name is one the records service writes and reads back.
    for (const { name } of listed) expect(parseInputObjectName(name), name).not.toBeNull();
    const r = await runAsync(["all", SHA], { state: live({}, withBucket({ objects: [], listed })), env: { SUPPORTED } });
    expect(r.status, r.stderr).toBe(0);
    // Both builds are declared and the old revision tagged before the new builder starts.
    const recordsDeploy = at(r, gcloudAt("antwar-records"));
    expect(at(r, upload(RUN_OLD))).toBeGreaterThanOrEqual(0);
    expect(at(r, upload(RUN_OLD))).toBeLessThan(recordsDeploy);
    expect(at(r, upload(RUN_NEW))).toBeGreaterThanOrEqual(0);
    expect(at(r, upload(RUN_NEW))).toBeLessThan(recordsDeploy);
    expect(r.calls.filter(isUpload)).toHaveLength(2);
    expect(at(r, gcloudAt("antwar-records", "--set-tags", `${OLD_TAG}=${RECORDS_OUT}`))).toBeLessThan(recordsDeploy);
    // The old builder stays tagged through every slot and the game, and drains only the snapshot's unbuilt input.
    const clearTags = at(r, gcloudAt("antwar-records", "--clear-tags"));
    expect(clearTags).toBeGreaterThan(at(r, (c) => c[0] === "gcloud" && c[3] === "update-traffic" && c[4] === "antwar" && c.includes("antwar-new=100")));
    expect(r.stderr).toContain(`antwar-records ${RECORDS_OUT} drain waits: inputs not yet built: ${OLD}\n`);
    expect(r.stderr).not.toContain(`not yet built: ${DONE}`);
    expect(r.stderr).not.toContain(GAVE_UP);
    expect(r.stderr).not.toContain(LATE);
    expect(roundSleeps(r)).toEqual([["sleep", "60"], ["sleep", "60"]]);
    // running/<old> goes once the tag is cleared; running/<new> last, after the final check.
    const rmOld = at(r, storage("rm", RUN_OLD)), rmNew = at(r, storage("rm", RUN_NEW));
    expect(rmOld).toBeGreaterThan(clearTags);
    expect(rmNew).toBeGreaterThan(rmOld);
    expect(rmNew).toBeGreaterThan(lastAt(r, (c) => c[0] === "gcloud" && c[2] === "revisions" && c[3] === "describe"));
    expect(rmNew).toBeGreaterThan(lastAt(r, (c) => c[0] === "gcloud" && c[3] === "describe" && c[4] === "antwar"));
    expect(r.state.bucket!.objects.filter((o) => !isMark(o))).toEqual([]);
    // One records builder, with today's untagged rollback.
    expect(r.state.services["antwar-records"]!.traffic).toEqual([{ revisionName: "antwar-records-new", percent: 100 }]);
    expect(r.stderr).toContain(`records rollback: revision ${RECORDS_OUT}, untagged: ${script} records-rollback ${RECORDS_OUT_SHA} ${RECORDS_OUT_DIGEST}`);
    expect(r.stderr).not.toContain("records overlap");
  }, TIMEOUT);

  it("rolling: stops at the drain's round limit naming the old revision still overlapping and the commands that end the overlap", async () => {
    const OLD = "2026-01-01T07-50-00-000Z-41";
    const r = await runAsync(["all", SHA], { state: live({}, withBucket({ objects: [], listed: [{ name: `${OLD}.input`, shows: 1e9 }] })),
      env: { SUPPORTED, ANTWAR_DEPLOY_ROUNDS: "2" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`stopping: the records drain is still waiting after 2 rounds: inputs not yet built: ${OLD}`);
    expect(r.stderr).toContain(`records overlap still active: antwar-records ${RECORDS_OUT} keeps tag ${OLD_TAG} so the builder of ${RECORDS_OUT_SHA} keeps building its matches' records; once they are built, end the overlap with, in order:\n`
      + "  gcloud run services update-traffic antwar-records --account operator@example.com --project example-project --region australia-southeast1 --clear-tags\n"
      + `  gcloud storage rm ${BUCKET}${RUN_OLD} --account operator@example.com --project example-project\n`
      + `  gcloud storage rm ${BUCKET}${RUN_NEW} --account operator@example.com --project example-project\n`);
    // The overlap is left as it was: both builders running and declared, everything else swapped.
    expect(r.state.services["antwar-records"]!.traffic).toContainEqual({ revisionName: RECORDS_OUT, tag: OLD_TAG });
    expect(r.state.bucket!.objects.filter((o) => !isMark(o)).sort()).toEqual([RUN_NEW, RUN_OLD].sort());
    expect(deployed(r)).toEqual(SERVICES);
    expect(r.state.curl!.withheld).toEqual([]);
    expect(r.stdout).toBe("");
  }, TIMEOUT);

  it("rolling: keeps running/<new> when the final check fails, naming the command that removes it", async () => {
    const r = await runAsync(["all", SHA], { state: live(), env: { SUPPORTED, WRONG_VERSION: "antwar-private-6" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`stopping: not done: the services above do not all serve ${SHA}`);
    expect(r.state.bucket!.objects.filter((o) => !isMark(o))).toEqual([RUN_NEW]);
    expect(r.stderr).toContain(`records overlap objects left; remove them with, in order:\n  gcloud storage rm ${BUCKET}${RUN_NEW} --account operator@example.com --project example-project\n`);
    expect(r.calls.some(storage("rm", RUN_NEW))).toBe(false);
  }, TIMEOUT);

  // Regression: a deploy once stopped at the records swap when its outgoing running/<commit> was
  // only the prefix of the previous successful run's marks.
  it("rolling: a deploy after a successful rolling deploy writes the outgoing running/<commit> beside that run's marks and ends DONE", async () => {
    const first = await runAsync(["all", SHA], { state: live(), env: { SUPPORTED } });
    expect(first.status, first.stderr).toBe(0);
    expect(first.statusFile).toMatch(/^DONE\n/);
    const marksA = first.state.bucket!.objects.filter((o) => o.startsWith(`running/${SHA}/`));
    expect(marksA).toHaveLength(SERVICES.length);
    for (const o of marksA) expect(isMark(o), o).toBe(true);
    // running/<A> is left only as the prefix of A's marks.
    expect(first.state.bucket!.objects.filter((o) => !isMark(o))).toEqual([]);

    const B = "9".repeat(40), RUN_B = runningBuildName(B);
    const second = await runAsync(["all", B], { state: (s) => { Object.assign(s, structuredClone(first.state)); }, env: { SUPPORTED: SHA } });
    expect(second.status, second.stderr).toBe(0);
    expect(second.statusFile).toMatch(/^DONE\n/);
    expect(second.stderr).not.toContain("Destination object name needed");
    const recordsDeploy = at(second, gcloudAt("antwar-records"));
    expect(at(second, upload(RUN_NEW))).toBeGreaterThanOrEqual(0);
    expect(at(second, upload(RUN_NEW))).toBeLessThan(recordsDeploy);
    expect(at(second, upload(RUN_B))).toBeGreaterThanOrEqual(0);
    expect(at(second, upload(RUN_B))).toBeLessThan(recordsDeploy);
    expect(second.calls.some(storage("rm", RUN_NEW))).toBe(true);
    expect(second.calls.some(storage("rm", RUN_B))).toBe(true);
    expect(second.state.bucket!.objects.filter((o) => !isMark(o))).toEqual([]);
    // A's marks are left exactly as they were.
    expect(second.state.bucket!.objects.filter((o) => o.startsWith(`running/${SHA}/`))).toEqual(marksA);
    for (const svc of SERVICES) expect(second.state.services[svc]!.traffic.filter((t) => t.percent), svc).toEqual([{ revisionName: `${svc}-new2`, percent: 100 }]);
  }, TIMEOUT);

  it("rolling: a failed running/<commit> write stops the run and names no object it did not write", async () => {
    // A mark under running/<SHA>/ (an earlier attempt at SHA); the upload of running/<SHA> is refused.
    const prior = `running/${SHA}/20260101T000000Z-${SHA.slice(0, 8)}/antwar-records-00003-xyz`;
    const r = await runAsync(["all", SHA], { state: live({ uploadFails: [RUN_NEW] }, withBucket({ objects: [prior] })), env: { SUPPORTED } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`stopping: writing ${BUCKET}${RUN_NEW} failed\n`);
    expect(r.statusFile).toContain(`step: records swap\nslot: none\nreason: writing ${BUCKET}${RUN_NEW} failed\n`);
    // Only running/<old> was written, and only it is named for removal.
    expect(r.state.bucket!.objects.filter((o) => !isMark(o))).toEqual([RUN_OLD]);
    expect(r.stderr).toContain(`records overlap objects left; remove them with, in order:\n  gcloud storage rm ${BUCKET}${RUN_OLD} --account operator@example.com --project example-project\n`);
    expect(r.stderr).not.toContain(`gcloud storage rm ${BUCKET}${RUN_NEW}`);
    expect(r.gcloud.filter((c) => c[1] === "deploy")).toEqual([]);
    expect(r.state.bucket!.objects).toContain(prior);
  }, TIMEOUT);

  it("uses today's full gate, unchanged, when any outgoing service predates the slot mark and the records overlap signal", async () => {
    const r = await runAsync(["all", SHA], { state: live({ queue: 1, lobbyAtGame: 1 }),
      env: { SUPPORTED: [RECORDS_OUT_SHA, SLOT_OUT_SHA].join(" ") } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain(` full gate: antwar runs ${GAME_OUT_SHA}, which does not contain 46d6c91bcaf385019fc8477646047c85a3263804`);
    expect(r.stderr).toContain("antwar-records waits: queue entries waiting in ranked-1v1");
    expect(r.stderr).toContain("antwar waits: lobbies open: lobby-7f3a:holding");
    expect(r.calls.filter((c) => c[0] === "curl" && curlTo(c).includes("/withheld/"))).toEqual([]);
    // Only this run's marks are written to the bucket: no running/<commit> overlap signal.
    expect(r.gcloud.filter((c) => c[0] === "storage" && !isMark(c[3]!.replace(BUCKET, "")))).toEqual([]);
    expect(r.calls.filter(isUpload)).toEqual([]);
    expect(r.gcloud.filter((c) => c[2] === "update-traffic" && c[3] === "antwar-records" && c.includes("--set-tags"))).toEqual([]);
    // The default fake supports nothing, so every other test above is also a full-gate run.
    const plain = await runAsync(["all", SHA], { state: live() });
    expect(plain.stderr).toContain(` full gate: antwar-records runs ${RECORDS_OUT_SHA}, which does not contain 46d6c91bcaf385019fc8477646047c85a3263804`);
  }, TIMEOUT);

  it("rolling: on a stop clears every mark except a slot mid-swap, which it names with the command that clears it", async () => {
    // Round limit: the busy slot was never touched, so its mark is cleared.
    const capped = await runAsync(["all", SHA], { state: live({ holders: { "public-5": 1e9 } }), env: { SUPPORTED, ANTWAR_DEPLOY_ROUNDS: "2" } });
    expect(capped.status).toBe(1);
    expect(capped.stderr).toContain("stopping: still busy after 2 rounds: antwar-public-5");
    expect(capped.stderr).toContain("released antwar-public-5: withheld/public-5 cleared");
    expect(capped.state.curl!.withheld).toEqual([]);
    expect(capped.stderr).toContain(`records overlap still active: antwar-records ${RECORDS_OUT} keeps tag ${OLD_TAG}`);

    // A failure mid-swap leaves that one slot withheld, named; every untouched slot is released.
    const unsafe = await runAsync(["all", SHA], { state: live({ stop: { "public-0": 200 } }), env: { SUPPORTED } });
    expect(unsafe.status).toBe(1);
    expect(unsafe.stderr).toContain("stopping: antwar-public-0 answers an unauthenticated POST /operator/stop with 200, not 401");
    expect(unsafe.state.curl!.withheld).toEqual(["public-0"]);
    expect(unsafe.stderr).toContain(`left withheld: antwar-public-0 takes no new match until cleared with: ${clearCommand("public-0")}\n`);
    expect(unsafe.calls.filter(mark("DELETE", "public-0"))).toEqual([]);

    // A mark that cannot be set stops the run before any slot is swapped.
    const unset = await runAsync(["all", SHA], { state: live({ withholdFails: ["private-2"] }), env: { SUPPORTED } });
    expect(unset.status).toBe(1);
    expect(unset.stderr).toContain("stopping: withholding antwar-private-2 failed");
    expect(deployed(unset)).toEqual(["antwar-records"]);
    expect(unset.state.curl!.withheld).toEqual([]);

    // A mark that cannot be cleared is named.
    const stuck = await runAsync(["all", SHA], { state: live({ releaseFails: ["public-1"] }), env: { SUPPORTED } });
    expect(stuck.status).toBe(1);
    expect(stuck.stderr).toContain("stopping: releasing antwar-public-1 (withheld/public-1) failed");
    expect(stuck.state.curl!.withheld).toEqual(["public-1"]);
    expect(stuck.stderr).toContain(`left withheld: antwar-public-1 takes no new match until cleared with: ${clearCommand("public-1")}\n`);
    expect(stuck.stderr.match(/^left withheld: /gm)).toHaveLength(1);
  }, TIMEOUT);

  // One deploy stopped at antwar-public-5: an instance of the outgoing revision took
  // the slot back mid-swap (last boot wins across revisions), so the new instance answered 503.
  describe("swap check", () => {
    const OLD5 = slotOut("antwar-public-5"), NEW5 = "antwar-public-5-new";
    const DEFAULT_WINDOW = { ANTWAR_SWAP_STABLE: "" };

    it("waits through the outgoing revision holding the slot and a superseded 503, and swaps once the new revision holds it 3 probes in a row", async () => {
      const r = await runAsync(["all", SHA], { state: live({ instanceSeq: { "public-5": [OLD5] }, stopSeq: { "public-5": [503] } }), env: DEFAULT_WINDOW });
      expect(r.status, r.stderr).toBe(0);
      expect(deployed(r)).toEqual(SERVICES);
      expect(r.stderr).toContain(` antwar-public-5 swap check 1: instances/public-5 names ${OLD5}, not ${NEW5}\n`);
      expect(r.stderr).toContain(" antwar-public-5 swap check 2: an unauthenticated POST /operator/stop answers 503, not 401\n");
      expect(r.stderr).toContain(` antwar-public-5 swap check 5: ${NEW5} holds slot public-5 (3 of 3 in a row)\n`);
      expect(r.calls.filter((c) => c[0] === "sleep" && c[1] === "5").length).toBeGreaterThan(0);
    }, TIMEOUT);

    it("converges when the outgoing revision retakes the slot during the no-traffic window, probing only after the traffic move", async () => {
      const r = await runAsync(["all", SHA], { state: live({ retakeAtDeploy: ["public-5"] }), env: DEFAULT_WINDOW });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toContain(" antwar-public-5 swap check 1: /ready answers 503, not 200\n");
      expect(r.stderr).toContain(` antwar-public-5 swap check 4: ${NEW5} holds slot public-5 (3 of 3 in a row)\n`);
      const move = at(r, gcloudAt("antwar-public-5", "--to-revisions"));
      const firstProbe = at(r, (c) => c[0] === "curl" && (curlTo(c) === `${url("antwar-public-5")}/ready` || curlTo(c) === `${FS_LIVE}/instances/public-5`));
      expect(move).toBeGreaterThan(at(r, gcloudAt("antwar-public-5")));
      expect(firstProbe).toBeGreaterThan(move);
      expect(r.state.services["antwar-public-5"]!.traffic).toEqual([{ revisionName: NEW5, percent: 100 }]);
    }, TIMEOUT);

    it("stops before the next slot, leaving a loud FAILED status, when the outgoing revision keeps the slot", async () => {
      const r = await runAsync(["all", SHA], { state: live({ retakeAtDeploy: ["public-5"], stuck: ["public-5"] }),
        env: { ...DEFAULT_WINDOW, SUPPORTED, ANTWAR_SWAP_PROBES: "4" } });
      expect(r.status).toBe(1);
      const reason = `antwar-public-5 swap check: ${NEW5} did not hold slot public-5 on 3 consecutive probes within 4; last: instances/public-5 names ${OLD5}, not ${NEW5}`;
      expect(r.stderr).toContain(`stopping: ${reason}\n`);
      expect(deployed(r)).toEqual(SERVICES.slice(0, 7));
      expect(r.stdout).toBe("");
      // The one fixed place: FAILED, the step, the slot, the reason and what every service is left serving.
      expect(r.statusFile).toMatch(new RegExp(`^FAILED\\nrun: \\d{8}T\\d{6}Z-${SHA.slice(0, 8)}\\nsha: ${SHA}\\nfinished: \\S+Z\\n`));
      expect(r.statusFile).toContain(`step: slot swap check antwar-public-5\nslot: public-5\nreason: ${reason}\nserving:\n`);
      expect(r.statusFile).toContain(SERVICES.map((svc, i) => `  ${svc} ${i < 7 ? `${svc}-new` : svc === "antwar" ? GAME_OUT : slotOut(svc)}\n`).join(""));
      expect(r.statusFile).toContain(`left: left withheld: antwar-public-5 takes no new match until cleared with: ${clearCommand("public-5")}\n`);
      expect(r.stderr).toContain(`==================== DEPLOY FAILED: ${SHA} ====================\nFAILED\n`);
      expect(r.stderr).toContain(` deploy status FAILED written to ${r.dir}/antwar-deploy-status\n`);
    }, TIMEOUT);

    it("stops when the slot changes hands between probes, never 3 in a row", async () => {
      const OLD2 = slotOut("antwar-public-2"), NEW2 = "antwar-public-2-new";
      const r = await runAsync(["all", SHA], { state: live({ instanceSeq: { "public-2": [NEW2, OLD2, NEW2, NEW2, OLD2, NEW2, NEW2, OLD2] } }),
        env: { ...DEFAULT_WINDOW, ANTWAR_SWAP_PROBES: "8" } });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`stopping: antwar-public-2 swap check: ${NEW2} did not hold slot public-2 on 3 consecutive probes within 8; last: instances/public-2 names ${OLD2}, not ${NEW2}\n`);
      expect(r.stderr).toContain(` antwar-public-2 swap check 7: ${NEW2} holds slot public-2 (2 of 3 in a row)\n`);
      expect(deployed(r)).toEqual(SERVICES.slice(0, 4));
      expect(r.statusFile).toContain("step: slot swap check antwar-public-2\nslot: public-2\n");
    }, TIMEOUT);
  });

  // A rolled-back attempt leaves its revisions as their services' latest created, at 0%,
  // and Cloud Run refuses to delete a latest created revision.
  describe("leftover revisions", () => {
    const ATTEMPT = "7".repeat(40), ATTEMPT_RUN = "20260101T000000Z-77777777";
    const lft = (svc: string) => `${svc}-00010-lft`;
    const LEFT = ["antwar-records", "antwar-public-0", "antwar-public-5", "antwar"];
    const outOf = (svc: string) => (svc === "antwar-records" ? RECORDS_OUT : svc === "antwar" ? GAME_OUT : slotOut(svc));
    // Each service in LEFT serves its outgoing revision by name; its latest created revision serves nothing.
    const leftovers = (curl: CurlState = {}, edit?: (s: State) => void) => live(curl, (s) => {
      for (const svc of LEFT) {
        s.services[svc] = { latest: lft(svc), created: lft(svc), traffic: [{ revisionName: outOf(svc), percent: 100 },
          ...s.services[svc]!.traffic.filter((t) => t.tag).map((t) => ({ revisionName: t.revisionName, tag: t.tag }))] };
        s.revisions[lft(svc)] = { image: `${SERVER_REPO}@sha256:${"7".repeat(64)}`, sha: ATTEMPT };
      }
      edit?.(s);
    });
    const marks = (svcs: readonly string[]) => svcs.map((svc) => `running/${ATTEMPT}/${ATTEMPT_RUN}/${lft(svc)}`);
    const expectLeftAlone = (r: Awaited<ReturnType<typeof runAsync>>) => {
      expect(r.status, r.stderr).toBe(0);
      expect(deployed(r)).toEqual(SERVICES);
      for (const svc of LEFT) {
        expect(r.stderr).toContain(` ${svc}: latest created ${lft(svc)} is a recorded leftover (running/${ATTEMPT}/${ATTEMPT_RUN}/${lft(svc)}), untagged at 0%; it gets no traffic\n`);
        expect(r.gcloud.filter((c) => c.some((w) => w.includes(lft(svc)))), svc).toEqual([]);
      }
      expect(r.gcloud.filter((c) => c.includes("--to-latest"))).toEqual([]);
      for (const svc of SERVICES) expect(r.state.services[svc]!.traffic.filter((t) => t.percent), svc).toEqual([{ revisionName: `${svc}-new`, percent: 100 }]);
    };

    it("lets a recorded, untagged, 0% leftover through from the bucket's run marks and never routes to it", async () => {
      const r = await runAsync(["all", SHA], { state: leftovers({}, withBucket({ objects: marks(LEFT) })) });
      expectLeftAlone(r);
    }, TIMEOUT);

    // --precheck: the preflight alone, for the deploy host's dry run before the next deploy.
    const changes = (r: { gcloud: string[][]; calls: string[][] }) => [
      ...r.gcloud.filter((c) => !((c[0] === "run" && (c[1] === "services" || c[1] === "revisions") && c[2] === "describe") || (c[0] === "storage" && c[1] === "ls"))),
      ...r.calls.filter((c) => c[0] === "curl" || c[0] === "probe"),
    ];
    it("--precheck changes nothing and reports clear when nothing blocks", async () => {
      const r = await runAsync(["all", SHA, "--precheck"], { state: live() });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toBe(`precheck ${SHA}: clear, nothing blocks a deploy of all 18 services\n`);
      expect(changes(r)).toEqual([]);
      // The precheck runs no probe, so it installs nothing.
      expect(r.calls.filter((c) => c[0] === "npm")).toEqual([]);
      for (const svc of SERVICES) expect(r.gcloud, svc).toContainEqual(named(svc));
      // No status file and no saved records spec: the last real run's outcome stays readable.
      expect(r.statusFile).toBeNull();
      expect(existsSync(join(r.dir, `records-rollback-${RECORDS_OUT}.json`))).toBe(false);
      expect(r.state.bucket?.objects ?? []).toEqual([]);
    }, TIMEOUT);

    it("--precheck lets recorded leftovers through, changing nothing", async () => {
      const r = await runAsync(["all", SHA, "--precheck"], { state: leftovers({}, withBucket({ objects: marks(LEFT) })) });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toBe(`precheck ${SHA}: clear, nothing blocks a deploy of all 18 services\n`);
      for (const svc of LEFT) expect(r.stderr).toContain(` ${svc}: latest created ${lft(svc)} is a recorded leftover (`);
      expect(changes(r)).toEqual([]);
      expect(r.state.bucket!.objects).toEqual(marks(LEFT));
      expect(r.statusFile).toBeNull();
    }, TIMEOUT);

    it("--precheck names every blocker and exits 1, changing nothing", async () => {
      const r = await runAsync(["all", SHA, "--precheck"], { onMain: false, state: leftovers({}, (s) => {
        s.bucket = { objects: marks(LEFT.filter((svc) => svc !== "antwar-public-5")) };
        s.services["antwar-public-0"]!.traffic.push({ revisionName: lft("antwar-public-0"), tag: "r77777777" });
        s.services["antwar-private-3"]!.traffic = [{ revisionName: slotOut("antwar-private-3"), percent: 50 }, { revisionName: "antwar-private-3-00008-tag", percent: 50 }];
      }) });
      expect(r.status).toBe(1);
      const blockers = [
        `${SHA} is not a commit on origin/main`,
        `antwar-public-0 does not serve exactly its latest created revision ${lft("antwar-public-0")} at 100% (serving: ${slotOut("antwar-public-0")}), and ${lft("antwar-public-0")}, recorded as ${marks(["antwar-public-0"])[0]}, carries traffic or a tag`,
        `antwar-public-5 does not serve exactly its latest created revision ${lft("antwar-public-5")} at 100% (serving: ${slotOut("antwar-public-5")}), and ${lft("antwar-public-5")} is recorded in no run mark`,
        `antwar-private-3 does not serve exactly its latest created revision ${slotOut("antwar-private-3")} at 100% (serving: NONE)`,
      ];
      expect(r.stdout).toBe(`precheck ${SHA}: 4 blocking\n${blockers.map((b) => `blocked: ${b}\n`).join("")}`);
      expect(changes(r)).toEqual([]);
      expect(r.statusFile).toBeNull();
    }, TIMEOUT);

    it("refuses an unrecorded leftover, or a recorded one carrying a tag or traffic, naming it, before any build or change", async () => {
      const unrecorded = await runAsync(["all", SHA], { state: leftovers({}, withBucket({ objects: marks(LEFT.filter((s) => s !== "antwar-public-5")) })) });
      expect(unrecorded.status).toBe(1);
      const reason = `antwar-public-5 does not serve exactly its latest created revision ${lft("antwar-public-5")} at 100% (serving: ${slotOut("antwar-public-5")}), and ${lft("antwar-public-5")} is recorded in no run mark`;
      expect(unrecorded.stderr).toContain(`refusing: ${reason}\n`);
      expect(unrecorded.gcloud.filter((c) => c[0] === "builds" || c[1] === "deploy" || c[2] === "update-traffic")).toEqual([]);
      expect(unrecorded.statusFile).toContain(`step: preflight\nslot: none\nreason: ${reason}\nserving:\n  antwar-records ${RECORDS_OUT}\n`);
      expect(unrecorded.statusFile).toContain(`  antwar ${GAME_OUT}\n`);

      const tagged = await runAsync(["all", SHA], { state: leftovers({}, (s) => {
        s.bucket = { objects: marks(LEFT) };
        s.services["antwar-public-0"]!.traffic.push({ revisionName: lft("antwar-public-0"), tag: "r77777777" });
      }) });
      expect(tagged.status).toBe(1);
      expect(tagged.stderr).toContain(`refusing: antwar-public-0 does not serve exactly its latest created revision ${lft("antwar-public-0")} at 100% (serving: ${slotOut("antwar-public-0")}), and ${lft("antwar-public-0")}, recorded as ${marks(["antwar-public-0"])[0]}, carries traffic or a tag\n`);
      expect(tagged.gcloud.filter((c) => c[0] === "builds" || c[1] === "deploy" || c[2] === "update-traffic")).toEqual([]);
    }, TIMEOUT);

    it("records each new revision as it is created, so a stopped run's revision lets the next run through and never gets traffic", async () => {
      const first = await runAsync(["all", SHA], { state: live(), env: { NOT_READY: "antwar-public-2" } });
      expect(first.status).toBe(1);
      expect(first.stderr).toContain(`stopping: antwar-public-2 antwar-public-2-new is not Ready; its traffic stays on ${slotOut("antwar-public-2")}\n`);
      expect(first.state.bucket!.objects.filter(isMark)).toHaveLength(4);
      expect(first.state.bucket!.objects).toContainEqual(expect.stringMatching(MARK("antwar-public-2-new")));
      expect(first.gcloud.filter((c) => c[2] === "update-traffic" && c[3] === "antwar-public-2")).toEqual([]);
      expect(first.statusFile).toContain(`step: slot swap antwar-public-2\nslot: public-2\n`);

      const next = await runAsync(["all", SHA], { state: (s) => { Object.assign(s, first.state); } });
      expect(next.status, next.stderr).toBe(0);
      expect(next.stderr).toContain(" antwar-public-2: latest created antwar-public-2-new is a recorded leftover (running/");
      expect(next.gcloud.filter((c) => c[2] === "update-traffic" && c.some((w) => w.startsWith("antwar-public-2-new=")))).toEqual([]);
      expect(next.state.services["antwar-public-2"]!.traffic).toEqual([{ revisionName: "antwar-public-2-new2", percent: 100 }]);
    }, TIMEOUT);

    // The rolling retry writes running/<SHA> while the stopped attempt's marks make it a prefix.
    it("rolling: a retry after a stopped attempt, the overlap ended as its stop named, writes running/<sha> beside the attempt's marks and ends DONE", async () => {
      const first = await runAsync(["all", SHA], { state: live(), env: { SUPPORTED, NOT_READY: "antwar-records" } });
      expect(first.status).toBe(1);
      expect(first.state.bucket!.objects.filter(isMark)).toEqual([expect.stringMatching(MARK("antwar-records-new"))]);
      // The operator ends the overlap with the commands the stop printed.
      expect(first.stderr).toContain("end the overlap with, in order:\n");
      const ended = structuredClone(first.state);
      ended.services["antwar-records"]!.traffic = ended.services["antwar-records"]!.traffic.filter((t) => t.percent).map(({ tag: _tag, ...t }) => t);
      ended.bucket!.objects = ended.bucket!.objects.filter(isMark);

      const next = await runAsync(["all", SHA], { state: (s) => { Object.assign(s, ended); }, env: { SUPPORTED } });
      expect(next.status, next.stderr).toBe(0);
      expect(next.statusFile).toMatch(/^DONE\n/);
      expect(next.stderr).not.toContain("Destination object name needed");
      expect(next.stderr).toContain(" antwar-records: latest created antwar-records-new is a recorded leftover (running/");
      expect(next.calls.some(upload(RUN_NEW))).toBe(true);
      expect(next.calls.some(storage("rm", RUN_NEW))).toBe(true);
      expect(next.state.bucket!.objects.filter((o) => !isMark(o))).toEqual([]);
      expect(next.state.services["antwar-records"]!.traffic).toEqual([{ revisionName: "antwar-records-new2", percent: 100 }]);
    }, TIMEOUT);
  });

  // A first deploy into a project with none of the 18 services yet.
  describe("first deploy", () => {
    const empty = (s: State) => {
      live()(s);
      for (const svc of SERVICES) delete s.services[svc];
      s.absent = ["antwar-records", "antwar"];
    };
    const FIRST = ` first deploy: all 18 services are absent, so each is created with no rollback, no gate and no domain comparison\n`;
    const changes = (r: { gcloud: string[][]; calls: string[][] }) => [
      ...r.gcloud.filter((c) => !((c[0] === "run" && (c[1] === "services" || c[1] === "revisions") && c[2] === "describe") || (c[0] === "storage" && c[1] === "ls"))),
      ...r.calls.filter((c) => c[0] === "curl" || c[0] === "probe"),
    ];
    const RUN_CREATE = "https://run.googleapis.com/v2/projects/example-project/locations/australia-southeast1/services?serviceId=";
    const MISSING = "antwar-public-3";
    const missingBlocker = `${MISSING} does not serve exactly its latest created revision ? at 100% (serving: unreadable)`;

    it("--precheck reports clear, changing nothing, when every service is absent", async () => {
      const r = await runAsync(["all", SHA, "--precheck"], { state: empty });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toBe(`precheck ${SHA}: clear, nothing blocks a deploy of all 18 services\n`);
      expect(r.stderr).toContain(FIRST);
      expect(changes(r)).toEqual([]);
      expect(r.statusFile).toBeNull();
      expect(Object.keys(r.state.services).filter((svc) => SERVICES.includes(svc))).toEqual([]);
    }, TIMEOUT);

    it("creates all 18 services with no rollback, gate or domain comparison, saying the comparison was skipped", async () => {
      const r = await runAsync(["all", SHA], { state: empty });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toContain(FIRST);
      expect(r.stdout).toBe(SERVICES.map((s) => `${s} ${s}-new\n`).join(""));
      expect(deployed(r)).toEqual(SERVICES);
      // Each is created by one create-only request, under its own identity, before its deploy; the deploy then
      // creates the new revision with no traffic, recorded, and moves all traffic to it by name.
      const creates = r.calls.filter((c) => c[0] === "curl" && curlTo(c).startsWith(RUN_CREATE));
      expect(creates.map((c) => curlTo(c).slice(RUN_CREATE.length))).toEqual(SERVICES);
      expect(r.state.created!.map((c) => [c.svc, c.serviceAccount, c.command])).toEqual(SERVICES.map((svc) =>
        [svc, svc === "antwar-records" ? "antwar-records@example-project.iam.gserviceaccount.com" : "antwar-run@example-project.iam.gserviceaccount.com", ["node"]]));
      for (const svc of SERVICES) {
        expect(indexOf(r.calls, (c) => c[0] === "curl" && curlTo(c) === RUN_CREATE + svc), svc)
          .toBeLessThan(indexOf(r.calls, (c) => c[0] === "gcloud" && c[2] === "deploy" && c[3] === svc));
      }
      for (const d of deploys(r.gcloud)) expect(d, d[2]).toContain("--no-traffic");
      for (const svc of SERVICES) {
        expect(r.state.services[svc]!.traffic, svc).toEqual([{ revisionName: `${svc}-new`, percent: 100 }]);
        expect(r.stderr).toContain(` ${svc}: no rollback: first deploy, it had no earlier revision\n`);
      }
      expect(r.state.bucket!.objects.filter(isMark)).toHaveLength(18);
      expect(r.gcloud.filter((c) => c.includes("--set-tags") || c.includes("--clear-tags"))).toEqual([]);
      // No gate: no queue, lobby, slot holder or slot status read, and no slot withheld.
      expect(r.calls.filter((c) => c[0] === "curl" && /\/(queueWaiting|lobbies|slots\/|withheld\/)|\/live\/status$/.test(curlTo(c)))).toEqual([]);
      expect(roundSleeps(r)).toEqual([]);
      // The forwarding rules are still read, and the site still answers before the run is done.
      expect(r.gcloud.filter((c) => c[0] === "compute")).toEqual([RULES_LIST]);
      expect(r.calls.filter((c) => c[0] === "curl" && curlTo(c) === "https://antwars.ai/")).toHaveLength(1);
      // Each created service is given every setting it runs on, from the deploy's own inputs: none is kept from
      // an earlier revision, since the service had none.
      const values = (svc: string) => r.state.revisions[`${svc}-new`]!.values!;
      const shared = { ANTWAR_RECORD_INPUT_BUCKET: CONFIG.RECORD_INPUT_BUCKET, ANTWAR_REPLAY_BUCKET: CONFIG.REPLAY_BUCKET,
        ANTWAR_CODE_VERSION: SHA, ANTWAR_PRIVATE_REPLAY_KEY: "secret:antwar-private-replay-key:1" };
      expect(values("antwar-records")).toMatchObject(shared);
      for (const slot of SLOTS) {
        expect(values(`antwar-${slot}`), slot).toMatchObject({ ...shared, ANTWAR_STORE_NAMESPACE: "live", GCLOUD_PROJECT: CONFIG.PROJECT,
          ANTWAR_SLOT: slot, ANTWAR_PUBLIC_URL: url(`antwar-${slot}`), ANTWAR_PUBLIC_SLOTS: "8", ANTWAR_PRIVATE_SLOTS: "8",
          ...(slot.startsWith("public") ? { ANTWAR_OPERATOR_TOKEN: "secret:ANTWAR_OPERATOR_TOKEN:latest" } : {}) });
      }
      expect(values("antwar")).toMatchObject({ ...shared, ANTWAR_STORE_NAMESPACE: "live", GCLOUD_PROJECT: CONFIG.PROJECT,
        ANTWAR_PUBLIC_SLOTS: "8", ANTWAR_PRIVATE_SLOTS: "8", ANTWAR_USERNAME_CLAIM_LIMIT_RULE: "client" });
      expect(Object.keys(values("antwar"))).toEqual(expect.arrayContaining(["ANTWAR_SLOT_URL_TEMPLATE", "ANTWAR_LOAD_BALANCER_ADDRESS"]));
      // Only the domain comparison is skipped, plainly, never as a pass.
      expect(r.calls.filter((c) => c[0] === "probe")).toEqual([]);
      expect(r.stderr).toContain(` done ${SHA} all 18 services, domain comparison SKIPPED, not a pass: first deploy, so https://antwars.ai is not compared with ${CONFIG.GAME_SERVICE_URL}`);
      expect(r.stderr).not.toContain("domain comparison passed");
      expect(r.statusFile).toMatch(/^DONE\n/);
    }, TIMEOUT);

    it("stops, deploying nothing and moving no traffic, when a service appears before its create-only request", async () => {
      const r = await runAsync(["all", SHA], { state: (s) => { empty(s); s.curl!.appearAtCreate = ["antwar-records"]; } });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(FIRST);
      expect(r.stderr).toContain("stopping: antwar-records already exists: the project is no longer empty, so this first deploy stops; nothing was deployed to antwar-records and none of its traffic moved\n");
      expect(r.gcloud.filter((c) => c[1] === "deploy" || c[2] === "update-traffic")).toEqual([]);
      expect(r.state.services["antwar-records"]!.traffic).toEqual([{ revisionName: "antwar-records-00001-other", percent: 100, latestRevision: true }]);
      expect(r.calls.filter((c) => c[0] === "probe")).toEqual([]);
      expect(r.statusFile).toMatch(/^FAILED\n/);
    }, TIMEOUT);

    it("fails, never reporting done, when a created service lacks a setting it needs", async () => {
      const r = await runAsync(["all", SHA], { state: empty, env: { DROP_ENV: "antwar:ANTWAR_STORE_NAMESPACE" } });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("mismatch: antwar antwar-new was created without ANTWAR_STORE_NAMESPACE\n");
      expect(r.stderr).not.toContain(` done ${SHA}`);
      expect(r.statusFile).toMatch(/^FAILED\n/);
    }, TIMEOUT);

    it("stops with nothing reverted when the site does not answer 200", async () => {
      const r = await runAsync(["all", SHA], { state: (s) => { empty(s); s.curl!.site = 503; } });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("stopping: https://antwars.ai/ answered 503, not 200, within 5 minutes of antwar-new serving; nothing was reverted, since this first deploy had no earlier revision of antwar\n");
      expect(r.calls.filter((c) => c[0] === "probe")).toEqual([]);
    }, TIMEOUT);

    it("1 of 18 missing: --precheck blocks it as today, and the run refuses before any change", async () => {
      const state = live({}, (s) => { delete s.services[MISSING]; });
      const pre = await runAsync(["all", SHA, "--precheck"], { state });
      expect(pre.status).toBe(1);
      expect(pre.stdout).toBe(`precheck ${SHA}: 1 blocking\nblocked: ${missingBlocker}\n`);
      expect(pre.stderr).not.toContain("first deploy");
      expect(changes(pre)).toEqual([]);

      const r = await runAsync(["all", SHA], { state });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`refusing: ${missingBlocker}\n`);
      expect(r.stderr).not.toContain("first deploy");
      expect(r.gcloud.filter((c) => c[0] === "builds" || c[1] === "deploy" || c[2] === "update-traffic")).toEqual([]);
    }, TIMEOUT);
  });

  // One stop went unseen for about 25 minutes.
  it("loud stop: an interrupted run leaves FAILED, naming the signal, the step and the slot", async () => {
    const r = await runAsync(["all", SHA], { state: live(), env: { TERM_ON_SLEEP: "1", ANTWAR_SWAP_STABLE: "" } });
    expect(r.status).toBe(143);
    expect(r.stderr).toContain("stopping: interrupted by SIGTERM\n");
    expect(r.statusFile).toContain("step: slot swap check antwar-public-0\nslot: public-0\nreason: interrupted by SIGTERM\nserving:\n");
    expect(r.statusFile).toMatch(/^FAILED\n/);
    expect(r.stderr).toContain(`==================== DEPLOY FAILED: ${SHA} ====================\n`);
  }, TIMEOUT);
});

// Deploy.sh repeats these names and rules from src rather than importing them. Each is asserted here
// against src; the deploy.sh side is asserted by the tests above (running/<commit> and the failure markers in the
// rolling records tests, withheld/<slot> through withheldDoc) or, for lobby expiry, directly below.
describe("names and rules deploy.sh shares with src", () => {
  /** A Store kept in memory, as test/lobby/lobby-unstarted.test.ts keeps one. */
  function memoryStore(): Store {
    const docs = new Map<string, Fields>();
    return {
      namespace: "deploy-contract-test",
      async get(path) { return docs.get(path) ?? null; },
      async transaction(step) {
        const next = await step(async (paths) => new Map(paths.map((path) => [path, docs.get(path) ?? null])));
        for (const write of next.writes) {
          if (write.op === "delete") docs.delete(write.path);
          else {
            if ((write.op === "create") === docs.has(write.path)) throw new Error(`unexpected ${write.op}: ${write.path}`);
            docs.set(write.path, { ...docs.get(write.path), ...write.fields });
          }
        }
        return next.result;
      },
      async query() { throw new Error("not used"); },
    };
  }
  const value = <T,>(outcome: { ok: true; value: T } | { ok: false; reason: string }): T => {
    if (!outcome.ok) throw new Error(outcome.reason);
    return outcome.value;
  };

  it("src/records reads a run mark as neither a running build, an input nor a failure marker", () => {
    // deploy.sh writes running/<sha>/<run>/<revision> beside running/<commit>.
    const mark = `running/${SHA}/20260101T000000Z-${SHA.slice(0, 8)}/antwar-public-5-00037-xyz`;
    expect(parseRunningBuildName(mark)).toBeNull();
    expect(parseInputObjectName(mark)).toBeNull();
    expect(parseRunningBuildName(runningBuildName(SHA))).toBe(SHA);
  });

  it("src/lobby/lobbies.ts withholds a slot exactly while the document deploy.sh writes for it exists", async () => {
    const store = memoryStore();
    const identities = createIdentities(store);
    const lobbies = createLobbies(store, identities, { publicSlots: 1, privateSlots: 1, now: () => Date.UTC(2026, 10, 3), random: () => 0 });
    const mark = (op: "create" | "delete") => store.transaction(async () => ({ result: undefined,
      writes: [op === "create" ? { op, path: withheldDoc("public-0"), fields: { by: "deploy" } } : { op, path: withheldDoc("public-0") }] }));
    const [ann, bob] = await Promise.all(["ann", "bob"].map(async (name) => value(await identities.claimUsername(name))));
    await mark("create");
    const { lobby } = value(await lobbies.createLobby(ann!.key, "public", 1));
    value(await lobbies.join(lobby.id, ann!.key));
    expect(value(await lobbies.join(lobby.id, bob!.key))).toMatchObject({ state: "waiting", slot: null });
    await mark("delete");
    expect(value(await lobbies.readLobby(lobby.id))).toMatchObject({ state: "holding", slot: "public-0" });
  });

  it("deploy.sh's lobby expiry agrees with src/lobby/lobbies.ts LOBBY_TTL_MS and isExpired at every boundary", () => {
    // Only the node program firestore_busy pipes each Firestore page into is run, its clock frozen; never deploy.sh.
    const program = /KIND="\$kind" node -e '([^']*)'\)" \|\| return 1/.exec(readFileSync(script, "utf8"))?.[1];
    expect(program, "firestore_busy's node program").toBeDefined();
    const NOW = Date.UTC(2026, 10, 3, 12);
    const ages = [0, LOBBY_TTL_MS - 1, LOBBY_TTL_MS, LOBBY_TTL_MS + 1, 10 * LOBBY_TTL_MS];
    const cases: { id: string; fields: Fields }[] = [];
    for (const state of [undefined, "open", "waiting", "holding", "ended"])
      for (const mode of [undefined, "", "ranked-1v1"])
        for (const createdAt of [undefined, "not-a-time", ...ages.map((age) => String(NOW - age))])
          cases.push({ id: `lobby-${cases.length}`, fields: {
            ...(state === undefined ? {} : { state }), ...(mode === undefined ? {} : { mode }), ...(createdAt === undefined ? {} : { createdAt }) } });
    const page = { documents: cases.map(({ id, fields }) => ({ name: `projects/p/databases/(default)/documents/namespaces/live/lobbies/${id}`,
      fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { stringValue: v }])) })) };
    const run = spawnSync(process.execPath, ["-e", `Date.now = () => ${NOW};\n${program}`],
      { input: JSON.stringify(page), env: { ...process.env, KIND: "lobbies" }, encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    const [nextPage, busy] = run.stdout.split("\n");
    expect(nextPage).toBe("");
    const expected = cases.filter(({ fields }) => fields.state !== "ended" && !isExpired(fields, NOW))
      .map(({ id, fields }) => `${id}:${fields.state ?? "?"}`);
    expect(busy!.split(",").filter(Boolean)).toEqual(expected);
    // The table reaches both sides of the rule: some stored open or waiting lobbies are expired, some are not.
    expect(cases.some(({ fields }) => (fields.state === "open" || fields.state === "waiting") && isExpired(fields, NOW))).toBe(true);
    expect(cases.some(({ fields }) => (fields.state === "open" || fields.state === "waiting") && !isExpired(fields, NOW))).toBe(true);
  });
});
