import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve("deploy/cloud-run/domain.sh");
const scratch: string[] = [];
afterEach(() => { for (const p of scratch.splice(0)) rmSync(p, { recursive: true, force: true }); });

// Fake external cloud boundary only; the actual shell/Node creation and
// reconciliation logic is exercised. No real gcloud executable is invoked.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "antwar-domain-test-")); scratch.push(dir);
  const state = join(dir, "state.json"), calls = join(dir, "calls.jsonl");
  writeFileSync(state, "{}"); writeFileSync(calls, "");
  writeFileSync(join(dir, "gcloud"), `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify(a)+'\\n');
if (a[0] !== '--quiet' || a[1] !== '--account' || a[2] !== 'operator@example.com' || a[3] !== '--project' || a[4] !== 'example-project' || process.env.CLOUDSDK_CORE_DISABLE_PROMPTS !== '1') process.exit(90);
const [area,kind,verb,name] = a.slice(5);
if (area !== 'compute') process.exit(91);
const flag = n => a.find(x => x.startsWith('--'+n+'='))?.slice(n.length+3);
if (kind === 'network-endpoint-groups' && verb === 'list' && !flag('regions')) process.exit(92);
// Real gcloud NEG create does not accept --description.
if (kind === 'network-endpoint-groups' && verb === 'create' && flag('description') !== undefined) process.exit(93);
if (process.env.FAIL_AT === kind+':'+verb) process.exit(7);
let state=JSON.parse(fs.readFileSync(process.env.STATE,'utf8'));
const k=kind+'/'+name;
let out=null;
const root='https://www.googleapis.com/compute/v1/projects/example-project/';
const ref=(type,n,region=false)=>root+(region?'regions/australia-southeast1/':'global/')+type+'/'+n;
if(verb==='list') out=Object.entries(state).filter(([k])=>k.startsWith(kind+'/')).map(([,v])=>v);
else if(verb==='describe') { if(!state[k]) process.exit(8); out=state[k]; }
else if(verb==='create') {
  if(state[k] || process.env.RACE_AT===kind) process.exit(9);
  let v={name,description:flag('description')};
  if(kind==='addresses') Object.assign(v,{address:'203.0.113.42',addressType:'EXTERNAL',ipVersion:flag('ip-version'),networkTier:flag('network-tier')});
  if(kind==='network-endpoint-groups') Object.assign(v,{networkEndpointType:'SERVERLESS',cloudRun:{service:flag('cloud-run-service')}});
  if(kind==='backend-services') Object.assign(v,{loadBalancingScheme:flag('load-balancing-scheme'),protocol:flag('protocol'),enableCDN:false,backends:[{group:ref('networkEndpointGroups',flag('network-endpoint-group'),true)}]});
  if(kind==='ssl-certificates') Object.assign(v,{type:'MANAGED',managed:{domains:flag('domains').split(','),status:'PROVISIONING'}});
  if(kind==='url-maps') v.defaultService=ref('backendServices',flag('default-service'));
  if(kind==='target-https-proxies'||kind==='target-http-proxies') v.urlMap=ref('urlMaps',flag('url-map'));
  if(kind==='target-https-proxies') v.sslCertificates=[ref('sslCertificates',flag('ssl-certificates'))];
  if(kind==='forwarding-rules') Object.assign(v,{IPAddress:state['addresses/'+flag('address')].address,IPProtocol:flag('ip-protocol'),portRange:flag('ports')+'-'+flag('ports'),loadBalancingScheme:flag('load-balancing-scheme'),networkTier:flag('network-tier'),target:ref(name.endsWith('-https')?'targetHttpsProxies':'targetHttpProxies',flag(name.endsWith('-https')?'target-https-proxy':'target-http-proxy'))});
  state[k]=v;
} else if(verb==='update') { if(!state[k] || !flag('update-labels')) process.exit(10); state[k].labels={app:'antwar'}; }
else if(verb==='import') { if(!state[k]) process.exit(11); state[k]=JSON.parse(fs.readFileSync(flag('source'),'utf8')); }
else process.exit(12);
fs.writeFileSync(process.env.STATE,JSON.stringify(state));
console.log(JSON.stringify(out));
`, { mode: 0o755 });
  // The private config file domain.sh reads (config.sh), with made-up values.
  const config = join(dir, "deploy.env");
  writeFileSync(config, "ACCOUNT=operator@example.com\nPROJECT=example-project\n");
  const env = { ...process.env, PATH: dir + ":" + process.env.PATH, STATE: state, CALLS: calls, ANTWAR_DEPLOY_CONFIG: config };
  return {
    state: () => JSON.parse(readFileSync(state, "utf8")) as Record<string, Record<string, unknown>>,
    setState: (v: unknown) => writeFileSync(state, JSON.stringify(v)),
    calls: () => readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((s) => JSON.parse(s) as string[]),
    clearCalls: () => writeFileSync(calls, ""),
    run: (phase: string, extra = {}) => spawnSync("bash", [script, phase], { encoding: "utf8", env: { ...env, ...extra } }),
  };
}

// Keep the comparison at each call site; expose the subprocess failure instead
// of reducing fixture setup failures to "expected 1 to be +0".
function expectExit(result: SpawnSyncReturns<string>, context = "") {
  return expect(result.status, [context, `exit code: ${result.status}`, `stderr:\n${result.stderr}`].filter(Boolean).join("\n"));
}

const mutations = (calls: string[][]) => calls.filter((a) => ["create", "update", "import"].includes(a[7]!));
const defaultFields = [
  { resource: "addresses/antwar-domain-ip", path: ["addressType"], wrong: "INTERNAL" },
  { resource: "addresses/antwar-domain-ip", path: ["networkTier"], wrong: "STANDARD" },
  { resource: "backend-services/antwar-domain-backend", path: ["enableCDN"], wrong: true },
  ...["http-redirect", "url-map"].flatMap((suffix) => {
    const parent = suffix === "http-redirect" ? ["defaultUrlRedirect"] : ["pathMatchers", "0", "defaultUrlRedirect"];
    return [
      { resource: `url-maps/antwar-domain-${suffix}`, path: [...parent, "stripQuery"], wrong: true },
      { resource: `url-maps/antwar-domain-${suffix}`, path: [...parent, "redirectResponseCode"], wrong: "FOUND" },
    ];
  }),
  ...["https", "http"].map((suffix) => ({ resource: `forwarding-rules/antwar-domain-${suffix}`, path: ["networkTier"], wrong: "STANDARD" })),
];
function fieldParent(state: Record<string, Record<string, unknown>>, resource: string, path: string[]) {
  return path.slice(0, -1).reduce((value, key) => value[key] as Record<string, unknown>, state[resource]!);
}

describe("Front-end creation boundary", () => {
  it("includes the actual subprocess stderr and exit code in fixture assertion failures", () => {
    const failed = fixture().run("reserve-ip", { FAIL_AT: "backend-services:list" });
    expectExit(failed).toBe(1);
    expect(failed.stderr).toContain("Command failed:");
    expect(() => expectExit(failed, "fixture setup").toBe(0))
      .toThrow(`fixture setup\nexit code: ${failed.status}\nstderr:\n${failed.stderr}`);
  });
  it("parses as shell and rejects unknown phases without external calls", () => {
    execFileSync("bash", ["-n", script]);
    const f = fixture(); expectExit(f.run("deploy")).toBe(2); expect(f.calls()).toEqual([]);
  });
  it("takes its account and project only from the private config file, stopping before any call when either is missing", () => {
    const f = fixture();
    const dir = mkdtempSync(join(tmpdir(), "antwar-domain-config-")); scratch.push(dir);
    const partial = join(dir, "deploy.env");
    writeFileSync(partial, "ACCOUNT=operator@example.com\n");
    // The environment never supplies a setting.
    const leaked = { ACCOUNT: "leaked@example.com", PROJECT: "leaked-project" };
    for (const [extra, message] of [
      [{ ANTWAR_DEPLOY_CONFIG: "" }, "refusing: ANTWAR_DEPLOY_CONFIG is not set; it names the private deploy config file, which must set ACCOUNT PROJECT\n"],
      [{ ANTWAR_DEPLOY_CONFIG: join(dir, "absent") }, `refusing: the deploy config file ${join(dir, "absent")} is missing or unreadable; it must set ACCOUNT PROJECT\n`],
      [{ ANTWAR_DEPLOY_CONFIG: partial }, `refusing: the deploy config file ${partial} lacks PROJECT\n`],
    ] as const) {
      const r = f.run("describe", { ...leaked, ...extra });
      expectExit(r, message).toBe(1);
      expect(r.stderr).toBe(message);
      expect(f.calls()).toEqual([]);
    }
  });
  it("reserves only labelled IPv4, emits exact DNS records immediately and makes reruns read-only", () => {
    const f = fixture(); const first = f.run("reserve-ip");
    expectExit(first).toBe(0);
    expect(Object.keys(f.state())).toEqual(["addresses/antwar-domain-ip"]);
    expect(first.stdout).toContain("antwars.ai. 300 IN A 203.0.113.42\nwww.antwars.ai. 300 IN A 203.0.113.42");
    expect(f.state()["addresses/antwar-domain-ip"]!.labels).toEqual({ app: "antwar" });
    f.clearCalls(); expectExit(f.run("reserve-ip")).toBe(0); expect(mutations(f.calls())).toEqual([]);
  });
  it("creates exactly the inventory, preserves paths/queries in both redirects and never writes Cloud Run or APIs", () => {
    const f = fixture(); expectExit(f.run("reserve-ip")).toBe(0);
    const run = f.run("create-remaining"); expectExit(run).toBe(0);
    const state = f.state(); expect(Object.keys(state)).toHaveLength(10);
    expect(state["network-endpoint-groups/antwar-domain-neg"]!.description).toBeUndefined();
    const negCreate = f.calls().find((a) => a[6] === "network-endpoint-groups" && a[7] === "create")!;
    expect(negCreate.some((a) => a.startsWith("--description="))).toBe(false);
    const https = state["url-maps/antwar-domain-url-map"]!;
    expect(https.hostRules).toEqual([{ hosts: ["www.antwars.ai"], pathMatcher: "www-redirect" }]);
    expect(https.pathMatchers).toEqual([{ name: "www-redirect", defaultUrlRedirect: { hostRedirect: "antwars.ai", httpsRedirect: true, redirectResponseCode: "MOVED_PERMANENTLY_DEFAULT", stripQuery: false } }]);
    const http = state["url-maps/antwar-domain-http-redirect"]!;
    expect(http.defaultService).toBeUndefined();
    expect(http.defaultUrlRedirect).toEqual({ hostRedirect: "antwars.ai", httpsRedirect: true, redirectResponseCode: "MOVED_PERMANENTLY_DEFAULT", stripQuery: false });
    for (const a of f.calls()) {
      expect(a.slice(0, 6)).toEqual(["--quiet", "--account", "operator@example.com", "--project", "example-project", "compute"]);
      expect(a.join(" ")).not.toMatch(/certificate-manager|services enable|auth |config |--timeout/);
    }
    for (const name of ["https", "http"]) expect(state[`forwarding-rules/antwar-domain-${name}`]!.labels).toEqual({ app: "antwar" });
    f.clearCalls(); const rerun = f.run("create-remaining"); expectExit(rerun).toBe(0); expect(mutations(f.calls())).toEqual([]);
    f.clearCalls(); expectExit(f.run("describe")).toBe(0); expect(mutations(f.calls())).toEqual([]);
    // This case starts roughly 60 isolated fake CLI processes. The first run
    // completed its assertions in 5.853 s, beyond Vitest's generic 5 s limit.
  }, 15_000);
  it("accepts API-omitted stripQuery false in both redirects without mutating on any rerun", () => {
    const f = fixture(); expectExit(f.run("reserve-ip")).toBe(0);
    expectExit(f.run("create-remaining")).toBe(0);
    const state = f.state();
    // Exact redirect object returned for the HTTP map by a live API read.
    const apiRedirect = { hostRedirect: "antwars.ai", httpsRedirect: true, redirectResponseCode: "MOVED_PERMANENTLY_DEFAULT" };
    const http = state["url-maps/antwar-domain-http-redirect"]!;
    expect(http.defaultService).toBeUndefined();
    http.defaultUrlRedirect = apiRedirect;
    f.setState(state); f.clearCalls(); const apiDescribe = f.run("describe");
    expectExit(apiDescribe).toBe(0);
    expect(mutations(f.calls())).toEqual([]);
    state["url-maps/antwar-domain-url-map"]!.pathMatchers = [{ name: "www-redirect", defaultUrlRedirect: apiRedirect }];
    f.setState(state);
    for (const phase of ["reserve-ip", "create-remaining", "describe"]) {
      f.clearCalls(); const run = f.run(phase);
      expectExit(run).toBe(0);
      expect(mutations(f.calls())).toEqual([]);
      expect(f.state()).toEqual(state);
    }
    // Missing a real reference must never be replaced with an inferred default.
    delete state["target-https-proxies/antwar-domain-https-proxy"]!.urlMap;
    f.setState(state); f.clearCalls(); const invalid = f.run("describe");
    expectExit(invalid).not.toBe(0);
    expect(invalid.stderr).toContain("conflicting/incomplete existing resource: target-https-proxies/antwar-domain-https-proxy");
    expect(mutations(f.calls())).toEqual([]);
  }, 15_000);
  it.each([true, null, "false", 0])("rejects explicit invalid stripQuery %j in either redirect", (stripQuery) => {
    const f = fixture(); expectExit(f.run("reserve-ip")).toBe(0);
    expectExit(f.run("create-remaining")).toBe(0);
    const state = f.state();
    for (const suffix of ["http-redirect", "url-map"]) {
      const invalid = structuredClone(state);
      const map = invalid[`url-maps/antwar-domain-${suffix}`]!;
      if (suffix === "http-redirect") (map.defaultUrlRedirect as Record<string, unknown>).stripQuery = stripQuery;
      else (map.pathMatchers as { defaultUrlRedirect: Record<string, unknown> }[])[0]!.defaultUrlRedirect.stripQuery = stripQuery;
      f.setState(invalid); f.clearCalls(); const run = f.run("describe");
      expectExit(run).not.toBe(0);
      expect(run.stderr).toContain(`conflicting/incomplete existing resource: url-maps/antwar-domain-${suffix}`);
      expect(mutations(f.calls())).toEqual([]);
      expect(f.state()).toEqual(invalid);
    }
  }, 15_000);
  it("accepts all documented matching defaults omitted together, with every phase read-only", () => {
    const f = fixture(); expectExit(f.run("reserve-ip")).toBe(0);
    expectExit(f.run("create-remaining")).toBe(0);
    const state = f.state();
    for (const { resource, path } of defaultFields) delete fieldParent(state, resource, path)[path.at(-1)!];
    f.setState(state);
    for (const phase of ["reserve-ip", "create-remaining", "describe"]) {
      f.clearCalls(); const run = f.run(phase);
      expectExit(run).toBe(0);
      expect(mutations(f.calls())).toEqual([]);
      expect(f.state()).toEqual(state);
    }
  }, 15_000);
  it("rejects explicit wrong and null values at every defaulted field instead of repairing them", () => {
    const f = fixture(); expectExit(f.run("reserve-ip")).toBe(0);
    expectExit(f.run("create-remaining")).toBe(0);
    const state = f.state();
    for (const { resource, path, wrong } of defaultFields) for (const value of [wrong, null]) {
      const invalid = structuredClone(state); fieldParent(invalid, resource, path)[path.at(-1)!] = value;
      f.setState(invalid); f.clearCalls(); const run = f.run("describe");
      expectExit(run, `${resource}.${path.join(".")}=${JSON.stringify(value)}`).not.toBe(0);
      expect(run.stderr).toContain(`conflicting/incomplete existing resource: ${resource}`);
      expect(mutations(f.calls())).toEqual([]);
      expect(f.state()).toEqual(invalid);
    }
    // Eighteen negative API cases each start eight fake inventory processes.
  }, 30_000);
  it("keeps nonmatching defaults, missing required fields and CLI-only defaults as failures", () => {
    const f = fixture(); expectExit(f.run("reserve-ip")).toBe(0);
    expectExit(f.run("create-remaining")).toBe(0);
    const state = f.state();
    const requiredFields = [
      ["addresses/antwar-domain-ip", ["ipVersion"]],
      ["addresses/antwar-domain-ip", ["labels", "app"]],
      ["network-endpoint-groups/antwar-domain-neg", ["networkEndpointType"]],
      ["network-endpoint-groups/antwar-domain-neg", ["cloudRun", "service"]],
      ["backend-services/antwar-domain-backend", ["protocol"]],
      ["backend-services/antwar-domain-backend", ["backends"]],
      ["backend-services/antwar-domain-backend", ["loadBalancingScheme"]],
      ["ssl-certificates/antwar-domain-cert", ["type"]],
      ["ssl-certificates/antwar-domain-cert", ["managed", "domains"]],
      ["url-maps/antwar-domain-http-redirect", ["defaultUrlRedirect", "httpsRedirect"]],
      ["url-maps/antwar-domain-url-map", ["pathMatchers", "0", "defaultUrlRedirect", "httpsRedirect"]],
      ["url-maps/antwar-domain-http-redirect", ["defaultUrlRedirect", "hostRedirect"]],
      ["url-maps/antwar-domain-url-map", ["defaultService"]],
      ["target-http-proxies/antwar-domain-http-proxy", ["urlMap"]],
      ["target-https-proxies/antwar-domain-https-proxy", ["urlMap"]],
      ["target-https-proxies/antwar-domain-https-proxy", ["sslCertificates"]],
      ["forwarding-rules/antwar-domain-https", ["IPProtocol"]],
      ["forwarding-rules/antwar-domain-https", ["IPAddress"]],
      ["forwarding-rules/antwar-domain-https", ["portRange"]],
      ["forwarding-rules/antwar-domain-https", ["target"]],
      ["forwarding-rules/antwar-domain-http", ["labels", "app"]],
    ] satisfies [string, string[]][];
    for (const [resource, path] of requiredFields) {
      const invalid = structuredClone(state); delete fieldParent(invalid, resource, path)[path.at(-1)!];
      f.setState(invalid); f.clearCalls(); const run = f.run("describe");
      expectExit(run, `${resource}.${path.join(".")}`).not.toBe(0);
      expect(run.stderr).toContain(`conflicting/incomplete existing resource: ${resource}`);
      expect(mutations(f.calls())).toEqual([]);
      expect(f.state()).toEqual(invalid);
    }
    // Each missing-field case launches the real script against eight fake reads.
  }, 30_000);
  it("preflights every existing resource before any write, and refuses foreign/incomplete resources", () => {
    const f = fixture(); expectExit(f.run("reserve-ip")).toBe(0);
    const s = f.state(); s["ssl-certificates/antwar-domain-cert"] = { name: "antwar-domain-cert", description: "foreign" }; f.setState(s);
    f.clearCalls(); expectExit(f.run("create-remaining")).not.toBe(0); expect(mutations(f.calls())).toEqual([]);
  });
  it("propagates inventory errors without assuming absence", () => {
    const f = fixture(); expectExit(f.run("reserve-ip", { FAIL_AT: "backend-services:list" })).not.toBe(0); expect(mutations(f.calls())).toEqual([]);
  });
  it("stops on a partial failure, does not create downstream objects or repair half-finished ones", () => {
    const f = fixture(); expectExit(f.run("reserve-ip")).toBe(0);
    expectExit(f.run("create-remaining", { FAIL_AT: "url-maps:import" })).not.toBe(0);
    expect(Object.keys(f.state()).some((s) => s.startsWith("target-"))).toBe(false);
    f.clearCalls(); expectExit(f.run("create-remaining")).not.toBe(0); expect(mutations(f.calls())).toEqual([]);
  });
  it("an insert race cannot turn URL map import into an update of somebody else's map", () => {
    const f = fixture(); expectExit(f.run("reserve-ip")).toBe(0);
    expectExit(f.run("create-remaining", { RACE_AT: "url-maps" })).not.toBe(0);
    expect(f.calls().some((a) => a[7] === "import")).toBe(false);
  });
  it("requires the separate IP handoff and documents every named resource", () => {
    const f = fixture(); expectExit(f.run("create-remaining")).not.toBe(0); expect(mutations(f.calls())).toEqual([]);
    const doc = readFileSync("deploy/cloud-run/TEARDOWN.md", "utf8");
    for (const suffix of ["ip", "neg", "backend", "cert", "url-map", "http-redirect", "https-proxy", "http-proxy", "https", "http"]) expect(doc).toContain("antwar-domain-" + suffix);
  });
});
