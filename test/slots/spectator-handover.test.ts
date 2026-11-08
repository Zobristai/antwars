import { describe, expect, it, vi } from "vitest";
import { SPECTATOR_SAVE_META_BYTES } from "../../src/live/handover.ts";
import type { LiveGame } from "../../src/server.ts";
import type { SimState } from "../../src/sim/types.ts";
import { spectatorHandover, type HandoverHub, type HandoverWatch } from "../../src/spectator.ts";

// If saving the stream or recording state fails, the match ends not_played with no
// rating writes, as for any failed save. The spectator side is part of
// the one handover save: saveSpectator is the save step's call, and its rejection is a
// failed save. These tests drive the two hooks against the hub and watch-controller shapes.

const STREAM = { tick: 4100, released: 1100, recording: { replayId: "1730336400000-77" } };
const WATCH = { access: { lobbyId: "lobby-1", visibility: "public", rated: true, mode: "1v1" }, startedAt: 1_730_336_400_000 };
const ACCESS = { lobbyId: "lobby-1", visibility: "public", rated: true, mode: "1v1" } as const;
const STATE = { tick: 4100 } as SimState;

function fakeHub(saveMatch: HandoverHub["saveMatch"] = async () => ({ meta: STREAM,
  parts: new Map([["stream-records", Uint8Array.of(1, 2, 3)], ["recording-frames", Uint8Array.of(4, 5)]]) })) {
  return { saveMatch: vi.fn(saveMatch), resumeMatch: vi.fn<HandoverHub["resumeMatch"]>() };
}

function fakeWatch(save: HandoverWatch["save"] = () => WATCH) {
  const identity = (agentId: string) => agentId === "a1" ? { displayName: "OwnerA", elo: 1500 } : undefined;
  return { identity, save: vi.fn(save), resume: vi.fn<HandoverWatch["resume"]>(async () => ({ access: ACCESS, identity })), adopted: vi.fn<HandoverWatch["adopted"]>() };
}

const houseIdle = { idleTicks: 0, activityTick: () => undefined };
const live = { spectatorHouseIdle: () => houseIdle } as unknown as LiveGame;

describe("spectator side of the handover save", () => {
  it("saves stream, recording and watch state as one spectator save, which the resuming server restores and can hand over again", async () => {
    const [hubA, watchA] = [fakeHub(), fakeWatch()];
    const save = await spectatorHandover(hubA, watchA, new Map([[3, "lobby-1"]])).saveSpectator(3);
    expect(hubA.saveMatch).toHaveBeenCalledWith(3);
    expect(watchA.save).toHaveBeenCalledWith("lobby-1");
    expect(JSON.parse(save.meta)).toEqual({ stream: STREAM, watch: WATCH });
    expect([...save.parts]).toEqual([["stream-records", Uint8Array.of(1, 2, 3)], ["recording-frames", Uint8Array.of(4, 5)]]);

    // The resuming server numbers the match its own way; its watch side is restored before its stream.
    const [hubB, watchB] = [fakeHub(), fakeWatch()];
    const lobbiesB = new Map<number, string>();
    const hooksB = spectatorHandover(hubB, watchB, lobbiesB);
    await hooksB.matchResumed(1, STATE, live, save);
    expect(watchB.resume).toHaveBeenCalledWith(WATCH, live);
    expect(hubB.resumeMatch).toHaveBeenCalledWith(1, STATE, { meta: STREAM, parts: new Map(save.parts) }, watchB.identity, houseIdle);
    expect(watchB.resume.mock.invocationCallOrder[0]).toBeLessThan(hubB.resumeMatch.mock.invocationCallOrder[0]!);
    // Restoring lists nothing; only the run's adoption does, under that run.
    expect(watchB.adopted).not.toHaveBeenCalled();
    hooksB.matchAdopted(2, "run-b");
    expect(watchB.adopted).not.toHaveBeenCalled();
    hooksB.matchAdopted(1, "run-b");
    expect(watchB.adopted).toHaveBeenCalledExactlyOnceWith("lobby-1", "run-b");

    // A second handover saves the resumed match from the server that resumed it.
    const again = await hooksB.saveSpectator(1);
    expect(hubB.saveMatch).toHaveBeenCalledWith(1);
    expect(watchB.save).toHaveBeenCalledWith("lobby-1");
    const hubC = fakeHub();
    await spectatorHandover(hubC, fakeWatch(), new Map()).matchResumed(1, STATE, live, again);
    expect(hubC.resumeMatch).toHaveBeenCalledOnce();
  });

  it.each(["stream", "recording"])("fails the save when the %s state cannot be saved", async (part) => {
    const failure = new Error(`${part} state not saved`);
    const watch = fakeWatch();
    await expect(spectatorHandover(fakeHub(async () => { throw failure; }), watch, new Map([[3, "lobby-1"]])).saveSpectator(3)).rejects.toBe(failure);
  });

  it("fails the save when the match's watch metadata cannot be saved", async () => {
    const failure = new Error("Missing spectator match metadata");
    const hooks = spectatorHandover(fakeHub(), fakeWatch(() => { throw failure; }), new Map([[3, "lobby-1"]]));
    await expect(hooks.saveSpectator(3)).rejects.toBe(failure);
  });

  it("fails the save of a match that streams no lobby", async () => {
    const hub = fakeHub();
    await expect(spectatorHandover(hub, fakeWatch(), new Map([[3, "lobby-1"]])).saveSpectator(4)).rejects.toThrow("streams no lobby");
    expect(hub.saveMatch).not.toHaveBeenCalled();
  });

  it(`fails the save when its meta would exceed ${SPECTATOR_SAVE_META_BYTES} UTF-8 bytes`, async () => {
    const overhead = Buffer.byteLength(JSON.stringify({ stream: { pad: "" }, watch: WATCH }));
    const sized = (pad: string) => spectatorHandover(fakeHub(async () => ({ meta: { pad }, parts: new Map() })), fakeWatch(), new Map([[3, "lobby-1"]])).saveSpectator(3);
    expect(Buffer.byteLength((await sized("x".repeat(SPECTATOR_SAVE_META_BYTES - overhead))).meta)).toBe(SPECTATOR_SAVE_META_BYTES);
    await expect(sized("x".repeat(SPECTATOR_SAVE_META_BYTES - overhead + 1))).rejects.toThrow(`over ${SPECTATOR_SAVE_META_BYTES}`);
    // Counted in bytes: two-byte characters reach the bound at half the length.
    await expect(sized("é".repeat(Math.floor((SPECTATOR_SAVE_META_BYTES - overhead) / 2) + 1))).rejects.toThrow(`over ${SPECTATOR_SAVE_META_BYTES}`);
  });

  it("fails the resume when the watch metadata, the stream or the saved meta cannot be restored", async () => {
    const save = await spectatorHandover(fakeHub(), fakeWatch(), new Map([[3, "lobby-1"]])).saveSpectator(3);
    const watch = fakeWatch();
    watch.resume.mockRejectedValueOnce(new Error("Spectator lobby not ready"));
    const lobbies = new Map<number, string>();
    await expect(spectatorHandover(fakeHub(), watch, lobbies).matchResumed(1, STATE, live, save)).rejects.toThrow("Spectator lobby not ready");

    const hub = fakeHub();
    hub.resumeMatch.mockImplementationOnce(() => { throw new Error("stream not restored"); });
    await expect(spectatorHandover(hub, fakeWatch(), lobbies).matchResumed(1, STATE, live, save)).rejects.toThrow("stream not restored");
    expect(lobbies.size).toBe(0);

    await expect(spectatorHandover(fakeHub(), fakeWatch(), lobbies).matchResumed(1, STATE, live, { meta: JSON.stringify({ watch: WATCH }), parts: new Map() }))
      .rejects.toThrow("no stream state");
  });
});
