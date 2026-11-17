import { afterEach, expect, it, vi } from "vitest";
import { claimBot, check } from "./slots-check.mjs";
import { TEST_NAME_WORDS } from "../../src/identity/testNames.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const reply = (body: object, status = 200) => new Response(JSON.stringify(body), { status });

it("the actual slot checker claims word-named bots for both lobbies", async () => {
  const names: string[] = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async (url: URL, options: RequestInit) => {
    if (url.pathname !== "/api/claim_username") throw new Error("stop before lobby creation");
    const { name } = JSON.parse(options.body as string);
    names.push(name);
    return reply({ key: "synthetic-key" });
  }));
  await expect(check("https://example.test", 4)).rejects.toThrow("stop before lobby creation");
  expect(names).toHaveLength(16);
  for (const name of names) {
    const words = name.split("-");
    expect(words).toHaveLength(3);
    words.forEach((word, i) => expect(TEST_NAME_WORDS[i]).toContain(word));
  }
});

it("a taken name retries a complete new word name, never appending a suffix", async () => {
  const names = ["calm-cedar-fox", "quiet-willow-wren"];
  const sent: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: URL, options: RequestInit) => {
    sent.push(JSON.parse(options.body as string).name);
    return sent.length === 1 ? reply({ error: "taken" }, 409) : reply({ key: "synthetic-key" });
  }));
  await expect(claimBot("https://example.test", () => names.shift()!)).resolves.toEqual({ name: "quiet-willow-wren", key: "synthetic-key" });
  expect(sent).toEqual(["calm-cedar-fox", "quiet-willow-wren"]);
});

it("taken-name retries are bounded", async () => {
  const fetch = vi.fn(async () => reply({ error: "taken" }, 409));
  vi.stubGlobal("fetch", fetch);
  await expect(claimBot("https://example.test", () => "calm-cedar-fox")).rejects.toThrow("after 32 attempts");
  expect(fetch).toHaveBeenCalledTimes(32);
});

it("other failures are not disguised as a name collision", async () => {
  const fetch = vi.fn(async () => reply({ error: "server_busy" }, 503));
  vi.stubGlobal("fetch", fetch);
  await expect(claimBot("https://example.test")).rejects.toThrow("server_busy");
  expect(fetch).toHaveBeenCalledOnce();
});
