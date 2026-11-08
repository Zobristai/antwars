/// <reference types="node" />
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { createIdentities } from "../../src/identity/identities.ts";
import { createLobbies, type Lobby } from "../../src/lobby/lobbies.ts";
import { createRatings } from "../../src/rating/ratings.ts";
import { createFirestore } from "../../src/store/firestore.ts";
import { tempDir } from "../server/helpers.ts";

// Two real startup processes sharing the emulator, each owning one slot.
// They invoke the production bootstrap with only the nest-window duration shortened.
// Runs inside `firebase emulators:exec --only firestore`; skipped only when the variable is unset.
const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || "demo-antwar";
const ROOT = join(import.meta.dirname, "..", "..");

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

const children: ChildProcess[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
});

/** Production startup with an explicit short test window; SIGKILL still skips close(). */
async function slotProcess(slot: string, port: number, namespace: string): Promise<ChildProcess> {
  const env: NodeJS.ProcessEnv = {
    ...process.env, PORT: String(port), DATA_DIR: join(tempDir(), slot), ANTWAR_SLOT: slot,
    ANTWAR_PUBLIC_URL: `http://127.0.0.1:${port}`, ANTWAR_STORE_NAMESPACE: namespace,
    FIRESTORE_EMULATOR_HOST: host, GCLOUD_PROJECT: projectId,
  };
  for (const name of ["ANTWAR_RULES", "ANTWAR_PLAYERS", "ANTWAR_OPERATOR_TOKEN", "ANTWAR_REPLAY_BUCKET"]) delete env[name];
  const child = spawn(process.execPath, ["--import", "./src/ts-resolve.mjs", "--input-type=module", "-e",
    'import { startMain } from "./src/main.ts"; await startMain({ startPickWindowMs: 100 });'],
    { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let output = "";
  child.stdout!.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr!.on("data", (chunk: Buffer) => (output += chunk.toString()));
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`slot server ${slot} did not start:\n${output}`)), 30_000);
    child.stdout!.on("data", () => {
      if (output.includes("slot server for")) { clearTimeout(timeout); resolve(); }
    });
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`slot server ${slot} exited with ${code}:\n${output}`)); });
  });
  return child;
}

type Call = (name: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; data: any }>;

async function mcpAt(url: string): Promise<Call> {
  const client = new Client({ name: "two-process-test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  clients.push(client);
  return async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { isError: r.isError === true, data: r.structuredContent };
  };
}

async function until<T>(check: () => Promise<T | undefined | false>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(100);
  }
}

/** A seat's observe while its match is running: a view with no result. */
const liveView = async (call: Call) => {
  const reply = await call("observe");
  return !reply.isError && reply.data.view !== undefined && reply.data.view.result === null ? reply.data.view : undefined;
};

describe.skipIf(!host)("two slot server processes sharing one store", { timeout: 180_000 }, () => {
  it("run a public and a private lobby's matches at once, each reached only through the lookup; a killed instance's match is not played and its restart plays the next lobby", async () => {
    const namespace = `t${process.pid}-${Date.now().toString(36)}`;
    const store = () => createFirestore({ projectId, namespace, emulatorHost: host });
    const identities = createIdentities(store());
    const lobbies = createLobbies(store(), identities, { countdownMs: 500 });
    const ratings = createRatings(store());
    const keyFor = async (name: string) => {
      const claimed = await identities.claimUsername(name);
      if (!claimed.ok) throw new Error(claimed.reason);
      return claimed.value;
    };
    async function fill(kind: "public" | "private", names: readonly string[]) {
      const keys = await Promise.all(names.map(keyFor));
      const created = await lobbies.createLobby(keys[0]!.key, kind, 1);
      if (!created.ok) throw new Error(created.reason);
      let lobby: Lobby = created.value.lobby;
      for (const key of keys) {
        const joined = await lobbies.join(lobby.id, key.key, created.value.inviteToken);
        if (!joined.ok) throw new Error(joined.reason);
        lobby = joined.value;
      }
      return { lobby, keys };
    }
    const read = async (id: string) => {
      const lobby = await lobbies.readLobby(id);
      if (!lobby.ok) throw new Error(lobby.reason);
      return lobby.value;
    };

    const [portA, portB] = [await freePort(), await freePort()];
    const urlA = `http://127.0.0.1:${portA}`;
    const urlB = `http://127.0.0.1:${portB}`;
    await slotProcess("public-0", portA, namespace);
    let processB = await slotProcess("private-0", portB, namespace);

    const pub = await fill("public", ["Pia", "Pat"]);
    const priv = await fill("private", ["Quinn", "Quill"]);
    const waiting = await fill("private", ["Rae", "Rex"]);
    expect([pub.lobby.slot, priv.lobby.slot, waiting.lobby.state]).toEqual(["public-0", "private-0", "waiting"]);

    // An agent on instance A looks up its private lobby and is sent to B.
    const atA = await mcpAt(`${urlA}/mcp`);
    const located = (await atA("locate_match", { lobbyId: priv.lobby.id })).data;
    expect(located).toEqual({ slot: "private-0", mcpUrl: `${urlB}/mcp`, spectatorUrl: `https://antwars.ai/?lobby=${priv.lobby.id}` });
    expect(await (await fetch(`${urlA}/lobbies/${priv.lobby.id}/match`)).json()).toEqual(located);
    // The same key is refused at the instance that does not play its lobby.
    const wrong = await until(async () => {
      const reply = await atA("join", { key: priv.keys[0]!.key });
      return reply.data.error?.code === "not_seated" ? reply : undefined;
    });
    expect(wrong.isError).toBe(true);

    const privateSeat = await mcpAt(located.mcpUrl);
    await until(async () => !(await privateSeat("join", { key: priv.keys[0]!.key })).isError);
    const publicLocated = (await privateSeat("locate_match", { lobbyId: pub.lobby.id })).data;
    expect(publicLocated.mcpUrl).toBe(`${urlA}/mcp`);
    const publicSeat = await mcpAt(publicLocated.mcpUrl);
    await until(async () => !(await publicSeat("join", { key: pub.keys[0]!.key })).isError);

    // Both matches are live at the same time, each seat in its own lobby's match.
    const [publicView, privateView] = await until(async () => {
      const views = [await liveView(publicSeat), await liveView(privateSeat)];
      return views.every(Boolean) ? views : undefined;
    });
    expect(publicView.agentId).not.toBe(privateView.agentId);
    // Both keep running: each seat sees its own match advance.
    await until(async () => ((await liveView(publicSeat))?.tick ?? -1) > publicView.tick);
    await until(async () => ((await liveView(privateSeat))?.tick ?? -1) > privateView.tick);

    // B is killed mid-match without close(); its restart records the match not played and plays the waiting lobby.
    processB.kill("SIGKILL");
    await new Promise((resolve) => processB.once("exit", resolve));
    expect((await read(priv.lobby.id)).state).toBe("holding");
    processB = await slotProcess("private-0", portB, namespace);
    expect(await until(async () => (await read(priv.lobby.id)).outcome ?? undefined)).toBe("not_played");
    for (const key of priv.keys) expect((await ratings.readRating(key.identity.id)).ratedMatches).toBe(0);
    const rejoin = await mcpAt(`${urlB}/mcp`);
    expect((await rejoin("join", { key: priv.keys[1]!.key })).data.error.code).toBe("match_not_played");

    expect((await read(waiting.lobby.id))).toMatchObject({ state: "holding", slot: "private-0" });
    const nextSeat = await mcpAt(`${urlB}/mcp`);
    await until(async () => !(await nextSeat("join", { key: waiting.keys[0]!.key })).isError);
    await until(() => liveView(nextSeat));
    // A's public match played on throughout.
    await until(() => liveView(publicSeat));
  });

  it("a second process taking a slot supersedes the first, which stops answering and exits with code 0", async () => {
    const namespace = `t${process.pid}-${Date.now().toString(36)}-r`;
    const [portA, portB] = [await freePort(), await freePort()];
    const first = await slotProcess("public-0", portA, namespace);
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      first.once("exit", (code, signal) => resolve({ code, signal })));
    expect((await fetch(`http://127.0.0.1:${portA}/ready`)).status).toBe(200);
    await slotProcess("public-0", portB, namespace);
    expect(await exited).toEqual({ code: 0, signal: null });
    await expect(fetch(`http://127.0.0.1:${portA}/wake`)).rejects.toThrow();
    expect((await fetch(`http://127.0.0.1:${portB}/ready`)).status).toBe(200);
  });
});
