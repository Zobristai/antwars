import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { Readable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountStores } from "../../src/accounts/service.ts";
import type { UsernameClaimLimitRule } from "../../src/accounts/caller.ts";
import { CLAIM_WINDOW_MS, RESERVED_USERNAMES, createIdentities, type Outcome } from "../../src/identity/identities.ts";
import { configureClientSource } from "../../src/server/clientSource.ts";
import { createLobbies } from "../../src/lobby/lobbies.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import type { Fields, Store, TransactionRead, TransactionStep } from "../../src/store/firestore.ts";
import { startServer, type GameServer } from "../../src/server.ts";
import { shortConfig, tempDir, TEST_MCP_CONFIG } from "../server/helpers.ts";
import { playable } from "../playable.ts";

// Independent specification: the production constant alone must not define the test's expectation.
const WORDS = "claude opus sonnet haiku anthropic gpt openai astra luna sol gemini google grok xai llama meta deepseek qwen kimi glm chatgpt mistral mixtral codestral minimax cohere moonshot zhipu baidu ernie bytedance doubao microsoft phi nvidia nemotron amazon nova".split(" ");
function value<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new Error(`expected success: ${outcome.reason}`);
  return outcome.value;
}

/** Deterministic transactional Store adapter, not a substitute for emulator race coverage. */
/** loadBalancers is ANTWAR_LOAD_BALANCER_ADDRESS for the shared client source; unset is none, as on a match slot. */
function world(rule: UsernameClaimLimitRule = "off", loadBalancers?: string) {
  configureClientSource(loadBalancers === undefined ? {} : { ANTWAR_LOAD_BALANCER_ADDRESS: loadBalancers });
  const docs = new Map<string, Fields>();
  const reads: string[] = [];
  let tail = Promise.resolve();
  let clock = 1_000_000;
  const store: Store = {
    namespace: "memory-test",
    async get(path) { return docs.get(path) ?? null; },
    transaction<T>(step: (read: TransactionRead) => Promise<TransactionStep<T>>): Promise<T> {
      const result = tail.then(async () => {
        const outcome = await step(async (paths) => {
          reads.push(...paths);
          return new Map(paths.map((path) => [path, docs.get(path) ?? null]));
        });
        for (const write of outcome.writes) {
          if (write.op === "create" ? docs.has(write.path) : !docs.has(write.path)) throw new Error("store precondition");
        }
        for (const write of outcome.writes) {
          if (write.op === "delete") docs.delete(write.path);
          else docs.set(write.path, write.op === "update" ? { ...docs.get(write.path), ...write.fields } : write.fields);
        }
        return outcome.result;
      });
      tail = result.then(() => {}, () => {});
      return result;
    },
    async query() { throw new Error("query not used in claim tests"); },
  };
  const identities = createIdentities(store, { now: () => clock });
  const stores: AccountStores = { identities, lobbies: createLobbies(store, identities), ratings: createRatings(store), usernameClaimLimitRule: rule };
  return { docs, reads, store, identities, stores, now: () => clock, advance(ms: number) { clock += ms; } };
}

const servers: GameServer[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const server of servers.splice(0)) await server.close();
  vi.restoreAllMocks();
  configureClientSource({});
});

async function serve(stores: AccountStores) {
  const server = await startServer({ port: 0, host: "127.0.0.1", dataDir: tempDir(), match: "immediate",
    simConfig: playable(shortConfig(60_000)), mcpConfig: TEST_MCP_CONFIG, accounts: stores });
  servers.push(server);
  return server.port;
}

type Body = Record<string, unknown>;
/** Node fetch replaces Host with the URL's authority; the diagnostic fixture must
 * actually send the requested Host over the wire, including on MCP requests. */
const fetchWithHost: typeof fetch = async (input, init) => {
  const url = input instanceof Request ? new URL(input.url) : new URL(input);
  const headers = Object.fromEntries(new Headers(init?.headers).entries());
  if (init?.body !== undefined && init.body !== null && typeof init.body !== "string") throw new Error("test client expects a string body");
  return new Promise<Response>((resolve, reject) => {
    const req = request(url, { method: init?.method, headers, signal: init?.signal ?? undefined }, (res) => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(res.headers)) {
        for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) responseHeaders.append(name, item);
      }
      const status = res.statusCode ?? 500;
      const body = status === 204 || status === 304 ? null : Readable.toWeb(res) as ReadableStream<Uint8Array>;
      resolve(new Response(body, { status, headers: responseHeaders }));
    });
    req.on("error", reject);
    req.end(init?.body);
  });
};

async function open(transport: "HTTP" | "MCP", port: number) {
  // This object is updated between calls on the SAME MCP session. The trust context
  // must come from each request, not the initialization request or session id.
  let headers: Record<string, string> = {};
  let client: Client | undefined;
  if (transport === "MCP") {
    client = new Client({ name: "quota-test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      fetch: (url, init) => {
        const merged = new Headers(init?.headers);
        for (const [name, value] of Object.entries(headers)) merged.set(name, value);
        return fetchWithHost(url, { ...init, headers: merged });
      },
    }));
    clients.push(client);
  }
  return async (op: string, args: Record<string, unknown>, forwarded?: string, host?: string) => {
    headers = { ...(forwarded === undefined ? {} : { "x-forwarded-for": forwarded }), ...(host ? { host } : {}) };
    if (client) {
      const result = await client.callTool({ name: op, arguments: args });
      return { ok: result.isError !== true, status: 0, body: result.structuredContent as Body };
    }
    const response = await fetchWithHost(`http://127.0.0.1:${port}/api/${op}`, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(args),
    });
    return { ok: response.ok, status: response.status, body: await response.json() as Body };
  };
}

describe("identity creation budgets without external services", () => {
  it("keeps one exact reserved list; tests every canonical boundary and plain-prefix exception", async () => {
    expect([...RESERVED_USERNAMES]).toEqual(WORDS);
    const w = world();
    for (const word of WORDS) {
      for (const input of [word, word.toUpperCase(), `${word}-bot`, `${word}_bot`, `${word}4`, `${word}9bot`]) {
        expect(await w.identities.claimUsername(input), input).toEqual({ ok: false, reason: "reserved_name" });
      }
      const fullwidth = [...word].map((letter) => String.fromCharCode(letter.charCodeAt(0) + 0xfee0)).join("");
      expect(await w.identities.claimUsername(fullwidth)).toEqual({ ok: false, reason: "reserved_name" });
    }
    expect(w.docs.size).toBe(0);
    for (const name of ["solar", "metal", "lunar", ...WORDS.map((word) => `${word}z`)]) value(await w.identities.claimUsername(name));
    const owner = value(await w.identities.claimUsername("owner"));
    // More model words than one day's handle budget: the next window takes the rest.
    for (const [i, word] of WORDS.entries()) {
      if (i > 0 && i % 20 === 0) w.advance(CLAIM_WINDOW_MS);
      value(await w.identities.createHandle(owner.key, word));
    }
  });

  it("preserves existing reserved accounts, key rotation, resolution and model-named handles", async () => {
    const w = world();
    const key = "existing-secret";
    const verifier = createHash("sha256").update(key).digest("hex");
    w.docs.set("identities/existing", { kind: "username", displayName: "Claude", canonical: "claude", verifier, claimedAt: String(w.now()), hasJoinedMatch: "true" });
    w.docs.set(`keys/${verifier}`, { identityId: "existing" });
    w.docs.set("usernames/claude", { identityId: "existing" });
    expect(value(await w.identities.resolveKey(key)).displayName).toBe("Claude");
    const next = value(await w.identities.rotateKey(key));
    expect(value(await w.identities.createHandle(next.key, "gpt4")).identity.displayName).toBe("Claude/gpt4");
    expect(await w.identities.claimUsername("claude")).toEqual({ ok: false, reason: "reserved_name" });
    expect(value(await w.identities.resolveKey(next.key)).id).toBe("existing");
  });

  it("charges only successful usernames, persists across instances, resets exactly at 24h and writes nothing on refusal", async () => {
    const w = world();
    value(await w.identities.claimUsername("taken"));
    for (let i = 0; i < 20; i++) expect(await w.identities.claimUsername("taken", "caller")).toEqual({ ok: false, reason: "taken" });
    for (const input of ["!", "claude", "gpt4"]) expect((await w.identities.claimUsername(input, "caller")).ok).toBe(false);
    expect([...w.docs.keys()].some((path) => path.startsWith("identityClaimLimits/"))).toBe(false);
    for (let i = 0; i < 10; i++) value(await w.identities.claimUsername(`agent${i}`, "caller"));
    const other = createIdentities(w.store, { now: w.now });
    const before = JSON.stringify([...w.docs]);
    expect(await other.claimUsername("excess", "caller")).toEqual({ ok: false, reason: "username_claim_limit" });
    expect(JSON.stringify([...w.docs])).toBe(before);
    expect(await other.findByDisplayName("excess")).toBeUndefined();
    w.advance(CLAIM_WINDOW_MS - 1);
    expect((await other.claimUsername("tooearly", "caller")).ok).toBe(false);
    w.advance(1);
    value(await other.claimUsername("nextday", "caller"));
    expect(JSON.stringify([...w.docs])).not.toContain('"caller"');
    value(await world().identities.claimUsername("agent0", "caller")); // independent namespace/store
  });

  it("enforces 20 handles per stable owner; rotation/reissue/retries cannot reset or consume its budget", async () => {
    const w = world();
    const owner = value(await w.identities.claimUsername("owner"));
    const other = value(await w.identities.claimUsername("other"));
    const first = value(await w.identities.createHandle(owner.key, "claude"));
    expect(await w.identities.createHandle(first.key, "child")).toEqual({ ok: false, reason: "not_owner_key" });
    expect(await w.identities.createHandle("invalid", "child")).toEqual({ ok: false, reason: "unknown_key" });
    for (let i = 0; i < 20; i++) expect(await w.identities.createHandle(owner.key, "claude")).toEqual({ ok: false, reason: "taken" });
    value(await w.identities.reissueHandleKey(owner.key, "claude"));
    for (let i = 1; i < 20; i++) value(await w.identities.createHandle(owner.key, `handle${i}`));
    const rotated = value(await w.identities.rotateKey(owner.key));
    const before = JSON.stringify([...w.docs]);
    expect(await w.identities.createHandle(rotated.key, "excess")).toEqual({ ok: false, reason: "handle_creation_limit" });
    expect(JSON.stringify([...w.docs])).toBe(before);
    value(await w.identities.createHandle(other.key, "claude"));
    expect(value(await w.identities.resolveKey(rotated.key)).id).toBe(owner.identity.id);
    w.advance(CLAIM_WINDOW_MS);
    value(await w.identities.createHandle(rotated.key, "nextday"));
  });

  it("limits key replacements to 5 per identity per 24 h; a refusal writes nothing and keeps the current key", async () => {
    const w = world();
    const owner = value(await w.identities.claimUsername("owner"));
    const handle = value(await w.identities.createHandle(owner.key, "agent"));
    let key = owner.key;
    for (let i = 0; i < 5; i++) key = value(await w.identities.rotateKey(key)).key;
    const before = JSON.stringify([...w.docs]);
    expect(await w.identities.rotateKey(key)).toEqual({ ok: false, reason: "key_rotation_limit" });
    expect(JSON.stringify([...w.docs])).toBe(before);
    expect(value(await w.identities.resolveKey(key)).id).toBe(owner.identity.id);
    // A handle's budget is its own; reissue_handle_key and the handle's own rotate_key share it.
    let handleKey = handle.key;
    for (let i = 0; i < 3; i++) handleKey = value(await w.identities.reissueHandleKey(key, "agent")).key;
    for (let i = 0; i < 2; i++) handleKey = value(await w.identities.rotateKey(handleKey)).key;
    const full = JSON.stringify([...w.docs]);
    expect(await w.identities.reissueHandleKey(key, "agent")).toEqual({ ok: false, reason: "key_rotation_limit" });
    expect(await w.identities.rotateKey(handleKey)).toEqual({ ok: false, reason: "key_rotation_limit" });
    expect(JSON.stringify([...w.docs])).toBe(full);
    expect(value(await w.identities.resolveKey(handleKey)).id).toBe(handle.identity.id);
    // Other identities keep their own budgets, and the count persists across instances.
    value(await w.identities.rotateKey(value(await w.identities.claimUsername("other")).key));
    expect(await createIdentities(w.store, { now: w.now }).rotateKey(key)).toEqual({ ok: false, reason: "key_rotation_limit" });
    // The window resets exactly at 24 hours.
    w.advance(CLAIM_WINDOW_MS - 1);
    expect(await w.identities.rotateKey(key)).toEqual({ ok: false, reason: "key_rotation_limit" });
    w.advance(1);
    key = value(await w.identities.rotateKey(key)).key;
    value(await w.identities.reissueHandleKey(key, "agent"));
  });

  it("wires the startup settings into accounts without adding a committed enabled config", () => {
    const main = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");
    expect(main).toContain("usernameClaimLimitRuleFromEnv(process.env)");
    expect(main).toContain("configureClientSource(process.env)");
    expect(main).toMatch(/accounts = \{[^;]*usernameClaimLimitRule \}/);
  });
});

for (const transport of ["HTTP", "MCP"] as const) {
  describe(`${transport} actual account wiring`, () => {
    it("ships off: malformed/missing addresses never refuse or count; logs shape only and lists all reserved words", async () => {
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      const w = world();
      // Exercise the AccountStores optional default, not merely an explicit off value.
      const { usernameClaimLimitRule: _unused, ...stores } = w.stores;
      const call = await open(transport, await serve(stores));
      for (let i = 0; i < 15; i++) {
        expect((await call("claim_username", { name: `person${i}` }, i % 2 ? "not-an-ip,secret" : undefined, "antwars.ai")).ok).toBe(true);
      }
      expect(w.reads.some((path) => path.startsWith("identityClaimLimits/"))).toBe(false);
      expect([...w.docs.keys()].some((path) => path.startsWith("identityClaimLimits/"))).toBe(false);
      const reply = await call("claim_username", { name: "ＣＬＡＵＤＥ" }, "203.0.113.123,private", "antwars.ai");
      expect(reply.ok).toBe(false);
      expect(reply.body.error).toBe("reserved_name");
      expect(reply.body.message).toEqual(expect.any(String));
      for (const word of WORDS) expect(String(reply.body.message).split(/[^a-z0-9]+/)).toContain(word);
      if (transport === "HTTP") expect(reply.status).toBe(400);
      expect(info).toHaveBeenCalledTimes(16);
      for (const [event, shape] of info.mock.calls) {
        expect(event).toBe("antwar username claim header shape");
        expect(Object.keys(shape as object).sort()).toEqual(["lastIsLoadBalancer", "route"]);
      }
      const logged = JSON.stringify(info.mock.calls);
      expect(logged).not.toMatch(/203\.0\.113|not-an-ip|secret|private|person0|ＣＬＡＵＤＥ/);
      expect(info.mock.calls.at(-1)?.[1]).toEqual({ route: "antwars.ai", lastIsLoadBalancer: false });
    });

    it("client with no load balancer (a match slot): spoofing cannot evade attacker quota or poison the victim; ten honest agents succeed", async () => {
      const w = world("client");
      const port = await serve(w.stores);
      const call = await open(transport, port);
      const suffix = (ip: string) => ip;
      for (let i = 0; i < 10; i++) {
        expect((await call("claim_username", { name: `attacker${i}` }, `203.0.113.${i},${suffix("192.0.2.20")}`)).ok).toBe(true);
      }
      for (const spoof of ["203.0.113.9", "192.0.2.99", "garbage,203.0.113.8"]) {
        const reply = await call("claim_username", { name: "excess" }, `${spoof},${suffix("192.0.2.20")}`);
        expect(reply.body.error).toBe("username_claim_limit");
        if (transport === "HTTP") expect(reply.status).toBe(429);
      }
      for (let i = 0; i < 10; i++) expect((await call("claim_username", { name: `honest${i}` }, suffix("192.0.2.99"))).ok).toBe(true);
      expect((await call("claim_username", { name: "honestexcess" }, suffix("192.0.2.99"))).body.error).toBe("username_claim_limit");
      expect(await w.identities.findByDisplayName("excess")).toBeUndefined();
      expect((await call("claim_username", { name: "nocaller" })).body.error).toBe("caller_unavailable");
    });

    it("enforces handle quota with matching refusal messages and preserves named handle creation", async () => {
      const w = world();
      const owner = value(await w.identities.claimUsername("owner"));
      const call = await open(transport, await serve(w.stores));
      expect((await call("create_handle", { key: owner.key, handle: "claude" })).ok).toBe(true);
      w.docs.set(`identityClaimLimits/handles-${owner.identity.id}`, { windowStart: String(w.now()), used: "20" });
      const before = JSON.stringify([...w.docs]);
      const reply = await call("create_handle", { key: owner.key, handle: "extra" });
      expect(reply.body).toEqual({ error: "handle_creation_limit", message: "This owner has created 20 handles in 24 hours. Reuse existing handles; try again after the 24-hour window." });
      if (transport === "HTTP") expect(reply.status).toBe(429);
      expect(JSON.stringify([...w.docs])).toBe(before);
    });

    it("refuses the sixth key replacement with 429 key_rotation_limit, writing nothing; the current key still works", async () => {
      const w = world();
      const owner = value(await w.identities.claimUsername("owner"));
      value(await w.identities.createHandle(owner.key, "agent"));
      const call = await open(transport, await serve(w.stores));
      let key = owner.key;
      for (let i = 0; i < 5; i++) {
        const reply = await call("rotate_key", { key });
        expect(reply.ok).toBe(true);
        key = String(reply.body.key);
      }
      const before = JSON.stringify([...w.docs]);
      const refused = await call("rotate_key", { key });
      expect(refused.body).toEqual({ error: "key_rotation_limit", message: "This identity's key has been replaced 5 times in 24 hours (rotate_key and reissue_handle_key count together). Its current key still works: keep using it, and try again after the 24-hour window." });
      if (transport === "HTTP") expect(refused.status).toBe(429);
      expect(JSON.stringify([...w.docs])).toBe(before);
      expect(value(await w.identities.resolveKey(key)).id).toBe(owner.identity.id);
      for (let i = 0; i < 5; i++) expect((await call("reissue_handle_key", { key, handle: "agent" })).ok).toBe(true);
      const reissue = await call("reissue_handle_key", { key, handle: "agent" });
      expect(reissue.body.error).toBe("key_rotation_limit");
      if (transport === "HTTP") expect(reissue.status).toBe(429);
    });

    it("client: claims count per client source behind the load balancer; forged hops are ignored and a missing client is refused", async () => {
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      // Documentation addresses only (RFC 5737, RFC 3849).
      const w = world("client", "192.0.2.10,2001:db8:ffff::a10");
      const call = await open(transport, await serve(w.stores));
      const viaLb = (client: string, forged = "") => `${forged}${client},192.0.2.10`;
      for (let i = 0; i < 10; i++) {
        expect((await call("claim_username", { name: `alpha${i}` }, viaLb("198.51.100.20", `203.0.113.${i},`), "antwars.ai")).ok).toBe(true);
      }
      const excess = await call("claim_username", { name: "alphaexcess" }, viaLb("198.51.100.20", "203.0.113.99,"), "antwars.ai");
      expect(excess.body.error).toBe("username_claim_limit");
      if (transport === "HTTP") expect(excess.status).toBe(429);
      // The same client calling the service address directly shares that budget.
      expect((await call("claim_username", { name: "alphadirect" }, "198.51.100.20")).body.error).toBe("username_claim_limit");
      // Another visitor through the same load balancer keeps its own budget.
      expect((await call("claim_username", { name: "beta0" }, viaLb("198.51.100.21"), "antwars.ai")).ok).toBe(true);
      // IPv6 clients are counted per /64, through the IPv6 load balancer address.
      for (let i = 0; i < 10; i++) {
        expect((await call("claim_username", { name: `gamma${i}` }, `2001:db8:1:2::${i + 1},2001:db8:ffff::a10`)).ok).toBe(true);
      }
      expect((await call("claim_username", { name: "gammaexcess" }, "2001:db8:1:2:ffff::1,2001:db8:ffff::a10")).body.error).toBe("username_claim_limit");
      expect((await call("claim_username", { name: "delta0" }, "2001:db8:1:3::1,2001:db8:ffff::a10")).ok).toBe(true);
      for (const forwarded of [undefined, "192.0.2.10", "garbage,192.0.2.10"]) {
        const reply = await call("claim_username", { name: "nocaller" }, forwarded, "antwars.ai");
        expect(reply.body.error, String(forwarded)).toBe("caller_unavailable");
        if (transport === "HTTP") expect(reply.status).toBe(400);
      }
      expect(info.mock.calls[0]?.[1]).toEqual({ route: "antwars.ai", lastIsLoadBalancer: true });
      expect(info.mock.calls.at(-1)?.[1]).toEqual({ route: "antwars.ai", lastIsLoadBalancer: true });
      expect(JSON.stringify(info.mock.calls)).not.toMatch(/192\.0\.2|198\.51\.100|203\.0\.113|2001:db8|garbage/);
    });
  });
}

it("returns identical reserved/quota JSON over both transports", async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const w = world("client");
  const port = await serve(w.stores);
  const http = await open("HTTP", port), mcp = await open("MCP", port);
  expect((await http("claim_username", { name: "gpt4" })).body).toEqual((await mcp("claim_username", { name: "gpt4" })).body);
  for (let i = 0; i < 10; i++) expect((await http("claim_username", { name: `quota${i}` }, "192.0.2.20")).ok).toBe(true);
  expect((await http("claim_username", { name: "excess" }, "192.0.2.20")).body).toEqual((await mcp("claim_username", { name: "excess" }, "192.0.2.20")).body);
});
