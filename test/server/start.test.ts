import { houseIdleSecondsFromEnv } from "../../src/mcp/config.js";
/// <reference types="node" />
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connect, tempDir, type Agent } from "./helpers.js";

const ROOT = join(import.meta.dirname, "..", "..");

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

let child: ChildProcess | null = null;
let agent: Agent | null = null;
afterEach(async () => {
  await agent?.close();
  agent = null;
  // npm runs node in a child: signal the whole process group.
  if (child?.pid !== undefined && child.exitCode === null) process.kill(-child.pid, "SIGTERM");
  child = null;
});

describe("npm start serves the non-playing entry point on PORT", () => {
  it("takes PORT and DATA_DIR but cannot join or start the retired match", async () => {
    const port = await freePort();
    const dataDir = join(tempDir(), "logs");
    const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), DATA_DIR: dataDir, ANTWAR_OPERATOR_TOKEN: "entrypoint-test-only", ANTWAR_HOUSE_IDLE_SECONDS: "27" };
    delete env.ANTWAR_RULES;
    delete env.ANTWAR_PLAYERS;
    delete env.ANTWAR_SLOT;
    delete env.ANTWAR_STORE_NAMESPACE;
    // Retired recording configuration must not create a handoff or require a code version.
    env.ANTWAR_RECORD_INPUT_BUCKET = "unused-entry-point-inputs";
    delete env.ANTWAR_CODE_VERSION;
    child = spawn("npm", ["start"], { cwd: ROOT, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout!.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr!.on("data", (chunk: Buffer) => (output += chunk.toString()));
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 20_000);
      child!.stdout!.on("data", () => {
        if (output.includes("listening")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child!.once("exit", (code) => reject(new Error(`npm start exited with ${code}:\n${output}`)));
    });
    expect(output).toContain(`port ${port}`);
    expect(existsSync(dataDir)).toBe(true);

    agent = await connect(port);
    const joined = await agent.call("join", {});
    expect(joined.isError, joined.text).toBe(true);
    expect(output).toContain("entry point does not host matches");
    expect(output).not.toContain("match 1 started");
    const origin = `http://127.0.0.1:${port}`;
    expect((await fetch(`${origin}/live/status`)).status).toBe(404);
    expect((await fetch(`${origin}/operator/start`, { method: "POST" })).status).toBe(404);
    const headers = { authorization: "Bearer entrypoint-test-only" };
    expect((await fetch(`${origin}/operator/start`, { method: "POST", headers })).status).toBe(404);
    expect((await fetch(`${origin}/operator/stop`, { method: "POST", headers })).status).toBe(404);
  }, 30_000);
});

it("validates the production house-only timeout and defaults to 300 seconds", () => {
  expect(houseIdleSecondsFromEnv({})).toBe(300);
  expect(houseIdleSecondsFromEnv({ ANTWAR_HOUSE_IDLE_SECONDS: "45" })).toBe(45);
  for (const value of ["0", "-1", "NaN", "Infinity", "bad"]) {
    expect(() => houseIdleSecondsFromEnv({ ANTWAR_HOUSE_IDLE_SECONDS: value })).toThrow("positive finite");
  }
});
