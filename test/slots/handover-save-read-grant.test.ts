/// <reference types="node" />
// The object reads restore performs fall within what
// deploy/cloud-run/record-service-setup.sh grants antwar-run, the identity deploy.sh runs the slot services as,
// and that grant reads nothing but handover saves.
//
// The save is written and read back through production's own wiring, matchSavesFromEnv as src/main.ts uses it,
// so the reads are the ones restore's options.saves.read makes (src/slots/slotServer.ts): the bucket client's
// authenticated JSON API media GETs (src/replays/access.ts), recorded at node:https. The setup script runs
// against a fake gcloud that records each call, and its antwar-run bindings on the input bucket are evaluated as
// Cloud Storage evaluates them: a role's permission holds on an object when the binding's condition holds for
// the object's resource name, projects/_/buckets/<bucket>/objects/<name>; objects.list is checked against the
// bucket's own name, projects/_/buckets/<bucket>.
//
// Both scripts read their identities and buckets from the private deploy config file (deploy/cloud-run/config.sh).
// One made-up config is given to both: the setup's grants are evaluated for the identity and bucket deploy.sh
// actually deploys the slot services with, as its recorded `gcloud run deploy` calls carry them.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { matchSavesFromEnv, type MatchSave } from "../../src/handover/saveStore.ts";
import { Game } from "../../src/mcp/game.ts";
import { PUBLIC_CONFIG } from "../../src/sim/config.ts";
import { testFirestore } from "../handover/helpers.ts";
import { playable } from "../playable.ts";
import { shortConfig, TEST_MCP_CONFIG } from "../server/helpers.ts";

/** The bucket as Cloud Storage holds it here, and every media GET made to it. */
const gcs = vi.hoisted(() => ({ objects: new Map<string, Uint8Array>(), reads: [] as string[] }));

// createGcsObjectReader reads through https.get; this answers it from the in-memory bucket.
vi.mock("node:https", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:https")>();
  const { EventEmitter } = await import("node:events");
  const { Readable } = await import("node:stream");
  const get = (url: URL, _options: unknown, respond: (response: unknown) => void) => {
    gcs.reads.push(String(url));
    const request = new EventEmitter();
    Object.assign(request, {
      setTimeout: () => request,
      destroy: (error?: Error) => { if (error) request.emit("error", error); request.emit("close"); return request; },
    });
    const name = /^\/storage\/v1\/b\/[^/]+\/o\/([^/]+)$/.exec(url.pathname)?.[1];
    const body = name === undefined ? undefined : gcs.objects.get(decodeURIComponent(name));
    setImmediate(() => {
      const response = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(body)]),
        { statusCode: body === undefined ? 404 : 200, headers: body === undefined ? {} : { "content-length": String(body.byteLength) } });
      respond(response);
      request.emit("close");
    });
    return request;
  };
  return { ...actual, get };
});

const SETUP = resolve("deploy/cloud-run/record-service-setup.sh");
const DEPLOY = resolve("deploy/cloud-run/deploy.sh");
const SLOW = playable(shortConfig(60_000, { ticksPerSecond: 2, queenFounding: PUBLIC_CONFIG.queenFounding }));

/**
 * The object permissions of the roles this check knows, from Cloud Storage's roles reference
 * (iam/docs/roles-permissions/storage). A role outside it fails the check until it is added here.
 */
const ROLE_OBJECT_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  "roles/storage.objectCreator": ["storage.objects.create"],
  "roles/storage.objectViewer": ["storage.objects.get", "storage.objects.list"],
};

interface Binding { readonly role: string; readonly condition: string | null }

/** The private deploy config both scripts are given, with made-up values. */
const CONFIG = {
  ACCOUNT: "operator@example.com",
  PROJECT: "grant-test-project",
  BUILD_BUCKET: "grant-test-build",
  BUILD_SA: "builder@grant-test-project.iam.gserviceaccount.com",
  RUN_SA: "slot-runner@grant-test-project.iam.gserviceaccount.com",
  RECORDS_SA: "record-builder@grant-test-project.iam.gserviceaccount.com",
  RECORD_INPUT_BUCKET: "grant-test-inputs",
  REPLAY_BUCKET: "grant-test-replays",
};

const scratch: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Every gcloud call script makes under CONFIG, as its argument list. The fake gcloud and git answer only what
 * `deploy.sh slots live` reads: the image digest, the project number, each slot service's address, its latest
 * created revision (a new one after each deploy) and the revision serving 100% once traffic is moved to it by
 * name, and that each revision is Ready.
 */
function scriptCalls(script: string, args: readonly string[] = []): string[][] {
  const dir = mkdtempSync(join(tmpdir(), "handover-grant-"));
  scratch.push(dir);
  const log = join(dir, "calls.jsonl");
  const config = join(dir, "deploy.env");
  writeFileSync(config, Object.entries(CONFIG).map(([k, v]) => `${k}=${v}\n`).join(""));
  writeFileSync(log, "");
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "gcloud"), `#!${process.execPath}
const fs = require("node:fs");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + "\\n");
// Per service: how many revisions its deploys created, and the one serving 100% (none until moved by name).
const statePath = ${JSON.stringify(join(dir, "services.json"))};
const services = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};
const service = (name) => (services[name] ??= { created: 0, serving: null });
const latest = (name) => service(name).created ? name + "-0000" + service(name).created : null;
if (a[0] === "artifacts") console.log("sha256:${"b".repeat(64)}");
if (a[0] === "projects") console.log("123456789");
if (a[0] === "run" && a[1] === "deploy") service(a[2]).created += 1;
if (a[0] === "run" && a[1] === "services" && a[2] === "update-traffic") service(a[3]).serving = a[a.indexOf("--to-revisions") + 1].replace(/=100$/, "");
if (a[0] === "run" && a[1] === "services" && a[2] === "describe") console.log(JSON.stringify({ metadata: { annotations: {
  "run.googleapis.com/urls": JSON.stringify(["https://" + a[3] + "-123456789.australia-southeast1.run.app"]) } }, status: {
  ...(latest(a[3]) ? { latestCreatedRevisionName: latest(a[3]), latestReadyRevisionName: latest(a[3]) } : {}),
  traffic: service(a[3]).serving ? [{ revisionName: service(a[3]).serving, percent: 100 }] : [] } }));
if (a[0] === "run" && a[1] === "revisions" && a[2] === "describe") console.log(JSON.stringify({ status: { conditions: [{ type: "Ready", status: "True" }] } }));
fs.writeFileSync(statePath, JSON.stringify(services));
`, { mode: 0o755 });
  writeFileSync(join(dir, "bin", "git"), `#!${process.execPath}
const a = process.argv.slice(2);
if (a.includes("rev-parse")) console.log(${JSON.stringify(dir)});
`, { mode: 0o755 });
  const { ANTWAR_DEPLOY_CONFIG: _inherited, ...env } = process.env;
  const run = spawnSync("bash", [script, ...args], { encoding: "utf8", env: { ...env, ANTWAR_DEPLOY_CONFIG: config, PATH: `${join(dir, "bin")}:${process.env.PATH}` } });
  expect(run.status, run.stderr).toBe(0);
  return readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
}

const flag = (call: readonly string[], name: string): string | undefined => {
  const at = call.indexOf(name);
  return at < 0 ? undefined : call[at + 1];
};

/** True when the binding's condition holds for the resource; only the one form the setup uses is understood. */
function conditionHolds(condition: string | null, resourceName: string): boolean {
  if (condition === null) return true;
  const prefix = /^expression=resource\.name\.startsWith\("([^"]+)"\),title=[A-Za-z0-9_-]+$/.exec(condition)?.[1];
  if (prefix === undefined) throw new Error(`a condition this check does not evaluate: ${condition}`);
  return resourceName.startsWith(prefix);
}

function permitted(bindings: readonly Binding[], permission: string, resourceName: string): boolean {
  return bindings.some((binding) => {
    const permissions = ROLE_OBJECT_PERMISSIONS[binding.role];
    if (permissions === undefined) throw new Error(`a role this check does not know: ${binding.role}`);
    return permissions.includes(permission) && conditionHolds(binding.condition, resourceName);
  });
}

describe("slot servers' read-back of handover saves under the canonical setup", () => {
  it("every object read restore makes is granted to antwar-run, and the grant reads nothing but handover saves", async () => {
    // The identity and record-input bucket deploy.sh actually runs every live slot service with.
    const slotDeploys = scriptCalls(DEPLOY, ["slots", "live", "a".repeat(40)]).filter((call) => call[0] === "run" && call[1] === "deploy");
    expect(slotDeploys).toHaveLength(16);
    const deployed = (call: readonly string[]) => {
      const env = flag(call, "--set-env-vars")!.split(",").map((kv) => kv.split("="));
      return { identity: flag(call, "--service-account"), bucket: env.find(([name]) => name === "ANTWAR_RECORD_INPUT_BUCKET")?.[1] };
    };
    const shapes = new Set(slotDeploys.map((call) => JSON.stringify(deployed(call))));
    expect(shapes.size).toBe(1);
    const { identity: runSa, bucket: inputBucket } = deployed(slotDeploys[0]!) as { identity: string; bucket: string };
    // They are the supplied config's, not anything the script itself names.
    expect([runSa, inputBucket]).toEqual([CONFIG.RUN_SA, CONFIG.RECORD_INPUT_BUCKET]);

    // What the setup, given the same config, grants that identity on that bucket, and nothing anywhere else.
    const calls = scriptCalls(SETUP);
    const member = `serviceAccount:${runSa}`;
    const grants = calls.filter((call) => flag(call, "--member") === member);
    expect(grants.every((call) => call.slice(0, 4).join(" ") === `storage buckets add-iam-policy-binding gs://${inputBucket}`)).toBe(true);
    const bindings: Binding[] = grants.map((call) => ({ role: flag(call, "--role")!, condition: flag(call, "--condition") ?? null }));
    expect(bindings.length).toBeGreaterThan(0);

    // A handover save written and read back through the slot server's own wiring.
    const uploads: string[] = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "metadata.google.internal") return Response.json({ access_token: "slot-identity-token" });
      if (url.hostname === "storage.googleapis.com" && init?.method === "POST" && url.pathname === `/upload/storage/v1/b/${inputBucket}/o`) {
        const name = url.searchParams.get("name")!;
        uploads.push(name);
        const body = new Uint8Array(await new Response(init?.body).arrayBuffer());
        if (url.searchParams.get("ifGenerationMatch") !== "0" || gcs.objects.has(name)) return new Response(null, { status: 412 });
        gcs.objects.set(name, body);
        return Response.json({});
      }
      if (url.hostname === "storage.googleapis.com") throw new Error(`unexpected bucket request ${init?.method ?? "GET"} ${url}`);
      return realFetch(input, init);
    }) as typeof fetch);
    const saves = matchSavesFromEnv({ ANTWAR_RECORD_INPUT_BUCKET: inputBucket }, testFirestore().store);
    const game = new Game({ simConfig: SLOW, mcpConfig: TEST_MCP_CONFIG });
    await game.join({});
    game.startMatch(1);
    game.tick();
    const gameSave = game.saveMatch();
    const save: MatchSave = { format: 1, lobbyId: "lobby-grant", revision: "r1", savedByRunId: "run-a", tick: gameSave.tick, savedAt: 1,
      game: gameSave, spectator: { meta: "{}", parts: new Map([["stream", new Uint8Array([1, 2, 3])], ["watch", new Uint8Array([4])]]) } };
    await saves.write(save);
    const restored = await saves.read("lobby-grant");
    expect(restored?.savedByRunId).toBe("run-a");
    expect(restored?.spectator?.parts).toEqual(save.spectator!.parts);

    // Each read is the JSON API's objects.get (media), which needs storage.objects.get on that object; together
    // they read every object the save stored.
    const readNames = gcs.reads.map((read) => {
      const url = new URL(read);
      expect(url.searchParams.get("alt")).toBe("media");
      const name = new RegExp(`^/storage/v1/b/${inputBucket}/o/([^/]+)$`).exec(url.pathname)?.[1];
      expect(name, read).toBeDefined();
      return decodeURIComponent(name!);
    });
    expect(new Set(readNames)).toEqual(new Set(gcs.objects.keys()));
    expect(new Set(readNames)).toEqual(new Set(["handover/lobby-grant/run-a/game", "handover/lobby-grant/run-a/spectator/stream", "handover/lobby-grant/run-a/spectator/watch"]));
    const objectName = (name: string) => `projects/_/buckets/${inputBucket}/objects/${name}`;
    for (const name of readNames) expect(permitted(bindings, "storage.objects.get", objectName(name)), name).toBe(true);
    // The save's own uploads stay within the create-only grant.
    for (const name of uploads) expect(permitted(bindings, "storage.objects.create", objectName(name)), name).toBe(true);

    // Nothing broader: no read of record inputs, failure markers, deploy markers or other prefixes, no listing,
    // and no read grant without its condition.
    for (const name of ["2026-10-31T00-00-00-000Z-1.input", "2026-10-31T00-00-00-000Z-1.failed-1", `running/${"a".repeat(40)}`, "handover", "handover-x/game", "x/handover/game"]) {
      expect(permitted(bindings, "storage.objects.get", objectName(name)), name).toBe(false);
    }
    expect(permitted(bindings, "storage.objects.list", `projects/_/buckets/${inputBucket}`)).toBe(false);
    expect(bindings.filter((binding) => ROLE_OBJECT_PERMISSIONS[binding.role]!.includes("storage.objects.get")).every((binding) => binding.condition !== null)).toBe(true);
  }, 60_000);
});
