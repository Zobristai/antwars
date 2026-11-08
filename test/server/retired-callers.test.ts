import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { createSlotCaptureFixture } from "../../web/capture/operator-check.ts";
import { discoverPublicWatch } from "../../web/capture/watch.ts";

const closes: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); });
const lobbyId = "11111111-1111-4111-8111-111111111111";

async function discoveryFixture(options: { seq?: string; empty?: boolean; status?: number } = {}) {
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(req.url!);
    if (req.url === "/watch/catalog") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ matches: options.empty ? [] : [{ lobbyId }] }));
    } else if (req.url === `/watch/live/${lobbyId}`) {
      res.writeHead(options.status ?? 200, { "content-type": "text/event-stream", ...(options.seq ? { "x-antwar-match": options.seq } : {}) });
      res.end(": keepalive\n\n");
    } else res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  closes.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, paths };
}

it("watch CLI discovers the public lobby, not a root match, even without a slot sequence header", async () => {
  const fixture = await discoveryFixture();
  expect(await discoverPublicWatch(fixture.origin)).toEqual({ lobbyId, seq: null });
  expect(fixture.paths).toEqual(["/watch/catalog", `/watch/live/${lobbyId}`]);
});

it("watch CLI preserves a direct slot's local log identity", async () => {
  const fixture = await discoveryFixture({ seq: "12" });
  expect(await discoverPublicWatch(fixture.origin)).toEqual({ lobbyId, seq: 12 });
});

it("watch discovery does not fall back to retired routes when no public lobby exists or a stream is unavailable", async () => {
  const empty = await discoveryFixture({ empty: true });
  await expect(discoverPublicWatch(empty.origin)).rejects.toThrow("no live public lobby");
  expect(empty.paths).toEqual(["/watch/catalog"]);
  const unavailable = await discoveryFixture({ status: 503 });
  await expect(discoverPublicWatch(unavailable.origin)).rejects.toThrow("public watch HTTP 503");
  expect(unavailable.paths).toEqual(["/watch/catalog", `/watch/live/${lobbyId}`]);
});

it("the capture admits through account keys and lobbies, checks slot authentication, and saves two stopped recordings", async () => {
  const fixture = await createSlotCaptureFixture(); closes.push(() => fixture.close());
  expect(fixture.server.game.match).toBeNull();
  expect(await fixture.control("start", "wrong")).toBe(401);
  expect(await fixture.control("start")).toBe(409);
  for (let count = 1; count <= 2; count++) {
    const id = await fixture.admit();
    expect((await discoverPublicWatch(fixture.origin)).lobbyId).toBe(id);
    expect(fixture.server.game.match?.result).toBeNull();
    // Headers/keepalives alone are not a playable live checkpoint. This guards
    // both simulation-age and spectator-clock gates in the real slot hub.
    const stream = await fetch(`${fixture.origin}/watch/live/${id}`, { signal: AbortSignal.timeout(5000) });
    const reader = stream.body!.getReader();
    let frames = "";
    try {
      while (!frames.includes("data: ")) {
        const chunk = await reader.read();
        expect(chunk.done).toBe(false);
        frames += new TextDecoder().decode(chunk.value);
      }
    } finally { await reader.cancel(); }
    expect(frames).toContain("data: ");
    await fixture.finish(id);
    expect(fixture.objects.size).toBe(count);
    const recording = await (await fetch(`${fixture.origin}/watch/recording/${id}`)).json() as { replayId: string };
    expect(recording.replayId).toBeTypeOf("string");
    const response = await fetch(`${fixture.origin}/replays/${recording.replayId}`);
    expect(response.status).toBe(200); await response.body?.cancel();
  }
}, 20_000);

it("operational callers contain no retired root requests or account-free probe joins", () => {
  const probe = readFileSync("deploy/cloud-run/probe.mjs", "utf8");
  const watch = readFileSync("web/capture/watch.ts", "utf8");
  const workflow = readFileSync(".github/workflows/antwar-public-probe.yml", "utf8");
  for (const source of [probe, watch, workflow]) {
    expect(source).not.toMatch(/\/live\/(?:current|status|replays|\d+)/);
    expect(source).not.toMatch(/\/operator\/(?:start|stop)/);
  }
  expect(probe).not.toContain('name: "join"');
  expect(workflow).not.toContain("probe.mjs join");
  const capture = readFileSync("web/capture/operator-check.ts", "utf8");
  expect(capture).toContain('slot: { slot: "public-0"');
  expect(capture).toContain('arguments: { key }');
  expect(capture).not.toContain("FALLBACK_LABEL"); // Root fallback belongs to the view-selection tests, not slot control.
});
