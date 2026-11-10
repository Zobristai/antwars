import { describe, expect, it } from "vitest";
import { createIdentities, type Outcome } from "../../src/identity/identities.ts";
import type { ChallengeOutcome } from "../../src/lobby/challenges.ts";
import { createLobbies, LOBBY_TTL_MS, type LobbyOutcome } from "../../src/lobby/lobbies.ts";
import { createRatings, RANKED_MODES } from "../../src/rating/ratings.ts";
import { createFirestore } from "../../src/store/firestore.ts";

/**
 * Leaving a lobby before its match starts, against the Firestore emulator: the seat goes, the last seat out closes
 * the lobby unplayed, a leave after start (or of a lobby without the leaver's seat) is refused and writes nothing,
 * no rating changes, and a house challenge left by its builder holds no place and reads expired, builder_left.
 */

// Runs inside `firebase emulators:exec --only firestore`, which sets
// FIRESTORE_EMULATOR_HOST and GCLOUD_PROJECT; skipped only when the variable is unset.
const host = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || "demo-antwar";
const HANDLE = "glm-5-3";

let counter = 0;
const freshNamespace = () => `lv${process.pid}-${Date.now().toString(36)}-${counter++}`;

function value<T>(outcome: Outcome<T> | LobbyOutcome<T> | ChallengeOutcome<T>): T {
  if (!outcome.ok) throw new Error(`expected success, got ${outcome.reason}`);
  return outcome.value;
}
const reasonOf = (outcome: { ok: boolean; reason?: string }) => outcome.ok ? "ok" : outcome.reason;

interface Keyed { readonly id: string; readonly key: string }

function world() {
  const namespace = freshNamespace();
  const clock = { t: Date.UTC(2026, 10, 10, 9, 0, 0) };
  const store = createFirestore({ projectId, namespace, emulatorHost: host });
  const ids = createIdentities(store);
  const lobbies = createLobbies(store, ids, { publicSlots: 1, privateSlots: 1, now: () => clock.t });
  const ratings = createRatings(store);
  const claim = async (name: string): Promise<Keyed> => { const c = value(await ids.claimUsername(name)); return { id: c.identity.id, key: c.key }; };
  const handleOf = async (owner: Keyed, name: string): Promise<Keyed> => { const c = value(await ids.createHandle(owner.key, name)); return { id: c.identity.id, key: c.key }; };
  const raw = (path: string) => store.get(path);
  const remove = (path: string) => store.transaction(async () => ({ result: null, writes: [{ op: "delete", path }] }));
  const allRatings = (id: string) => Promise.all(RANKED_MODES.map((mode) => ratings.readRating(id, mode)));
  return { clock, lobbies, claim, handleOf, raw, remove, allRatings };
}

describe.skipIf(!host)("leaving a lobby before its match starts", { timeout: 60_000 }, () => {
  it("removes the leaver's seat before start; the lobby stays open for the others", async () => {
    const w = world();
    const [ann, bea] = [await w.claim("Ann"), await w.claim("Bea")];
    const { lobby } = value(await w.lobbies.createLobby(ann.key, "public", 2));
    value(await w.lobbies.join(lobby.id, ann.key));
    value(await w.lobbies.join(lobby.id, bea.key));

    const left = value(await w.lobbies.leave(lobby.id, ann.key));
    expect(left).toMatchObject({ state: "open", startsAt: null, outcome: null, creatorId: ann.id });
    expect(left.colonies.flat().map((seat) => seat.id)).toEqual([bea.id]);
    const stored = (await w.raw(`lobbies/${lobby.id}`))!;
    expect(JSON.parse(stored.seats!).map((seat: { id: string }) => seat.id)).toEqual([bea.id]);
    expect(stored.state).toBe("open");
    // Still listed and joinable, the creator's start_lobby still its own.
    expect((await w.lobbies.listPublic()).map((listed) => listed.id)).toEqual([lobby.id]);
  });

  it("closes the lobby unplayed when the last seat leaves: ended, not_played, no startsAt, unlisted", async () => {
    const w = world();
    const ann = await w.claim("Ann");
    const { lobby } = value(await w.lobbies.createLobby(ann.key, "public", 1));
    value(await w.lobbies.join(lobby.id, ann.key));

    const left = value(await w.lobbies.leave(lobby.id, ann.key));
    expect(left).toMatchObject({ state: "ended", outcome: "not_played", startsAt: null, slot: null, rated: null, colonies: [[], []] });
    expect(await w.raw(`lobbies/${lobby.id}`)).toMatchObject({ state: "ended", outcome: "not_played", startsAt: "", seats: "[]" });
    expect(await w.lobbies.listPublic()).toEqual([]);
    expect(reasonOf(await w.lobbies.join(lobby.id, ann.key))).toBe("started");
  });

  it("refuses a leave once the match has started (holding, waiting or ended) and changes nothing", async () => {
    const w = world();
    const [ann, bea, cat, dot] = [await w.claim("Ann"), await w.claim("Bea"), await w.claim("Cat"), await w.claim("Dot")];
    const first = value(await w.lobbies.createLobby(ann.key, "public", 1)).lobby;
    value(await w.lobbies.join(first.id, ann.key));
    expect(value(await w.lobbies.join(first.id, bea.key)).state).toBe("holding");
    const second = value(await w.lobbies.createLobby(cat.key, "public", 1)).lobby;
    value(await w.lobbies.join(second.id, cat.key));
    expect(value(await w.lobbies.join(second.id, dot.key)).state).toBe("waiting");

    for (const [lobbyId, who] of [[first.id, ann], [first.id, bea], [second.id, cat]] as const) {
      const before = await w.raw(`lobbies/${lobbyId}`);
      expect(reasonOf(await w.lobbies.leave(lobbyId, who.key))).toBe("started");
      expect(await w.raw(`lobbies/${lobbyId}`)).toEqual(before);
    }
    // Ended after play: still started.
    value(await w.lobbies.releaseSlot(first.id));
    const ended = await w.raw(`lobbies/${first.id}`);
    expect(ended!.state).toBe("ended");
    expect(reasonOf(await w.lobbies.leave(first.id, ann.key))).toBe("started");
    expect(await w.raw(`lobbies/${first.id}`)).toEqual(ended);
  });

  it("refuses a lobby the identity is not in, a repeated leave, a missing lobby and an expired lobby, changing nothing", async () => {
    const w = world();
    const [ann, bea, cat] = [await w.claim("Ann"), await w.claim("Bea"), await w.claim("Cat")];
    const { lobby } = value(await w.lobbies.createLobby(ann.key, "private", 2));
    value(await w.lobbies.join(lobby.id, ann.key, value(await w.lobbies.issueInvite(lobby.id, ann.key)).inviteToken));
    const before = await w.raw(`lobbies/${lobby.id}`);
    // The creator holds no seat until it joins; another identity holds none here.
    expect(reasonOf(await w.lobbies.leave(lobby.id, bea.key))).toBe("not_seated");
    expect(reasonOf(await w.lobbies.leave("00000000-0000-4000-8000-000000000000", bea.key))).toBe("not_seated");
    expect(reasonOf(await w.lobbies.leave(lobby.id, "not-a-key"))).toBe("unknown_key");
    expect(await w.raw(`lobbies/${lobby.id}`)).toEqual(before);

    value(await w.lobbies.leave(lobby.id, ann.key));
    const after = await w.raw(`lobbies/${lobby.id}`);
    expect(reasonOf(await w.lobbies.leave(lobby.id, ann.key))).toBe("not_seated");
    expect(await w.raw(`lobbies/${lobby.id}`)).toEqual(after);

    const stale = value(await w.lobbies.createLobby(cat.key, "public", 2)).lobby;
    value(await w.lobbies.join(stale.id, cat.key));
    w.clock.t += LOBBY_TTL_MS;
    const expired = await w.raw(`lobbies/${stale.id}`);
    expect(reasonOf(await w.lobbies.leave(stale.id, cat.key))).toBe("expired");
    expect(await w.raw(`lobbies/${stale.id}`)).toEqual(expired);
  });

  it("changes no rating in any mode", async () => {
    const w = world();
    const [ann, bea] = [await w.claim("Ann"), await w.claim("Bea")];
    const before = [await w.allRatings(ann.id), await w.allRatings(bea.id)];
    const { lobby } = value(await w.lobbies.createLobby(ann.key, "public", 2));
    value(await w.lobbies.join(lobby.id, ann.key));
    value(await w.lobbies.join(lobby.id, bea.key));
    value(await w.lobbies.leave(lobby.id, bea.key));
    value(await w.lobbies.leave(lobby.id, ann.key));
    expect([await w.allRatings(ann.id), await w.allRatings(bea.id)]).toEqual(before);
    expect((await w.raw(`lobbies/${lobby.id}`))!.rated).toBe("");
  });

  it("frees the leaver at once: the same lobby, another lobby, the ranked queue and a challenge all admit it", async () => {
    const w = world();
    const house = await w.claim("antwars");
    await w.handleOf(house, HANDLE);
    const [ann, bea] = [await w.claim("Ann"), await w.claim("Bea")];
    const { lobby } = value(await w.lobbies.createLobby(bea.key, "public", 2));
    value(await w.lobbies.join(lobby.id, bea.key));
    value(await w.lobbies.join(lobby.id, ann.key));
    expect(reasonOf(await w.lobbies.requestChallenge(ann.key, `antwars/${HANDLE}`))).toBe("seated_elsewhere");

    value(await w.lobbies.leave(lobby.id, ann.key));
    value(await w.lobbies.join(lobby.id, ann.key));
    value(await w.lobbies.leave(lobby.id, ann.key));
    const other = value(await w.lobbies.createLobby(bea.key, "public", 2)).lobby;
    value(await w.lobbies.join(other.id, ann.key));
    value(await w.lobbies.leave(other.id, ann.key));
    const challenge = value(await w.lobbies.requestChallenge(ann.key, `antwars/${HANDLE}`));
    value(await w.lobbies.leave(challenge.lobbyId, ann.key));
    expect(value(await w.lobbies.joinQueue(ann.key, "1v1")).state).toBe("waiting");
  });

  describe("a house challenge left by its builder before start", () => {
    async function challenged() {
      const w = world();
      const house = await w.claim("antwars");
      const seat = await w.handleOf(house, HANDLE);
      const builder = await w.claim("Ann");
      const left = async () => value(await w.lobbies.listChallengeOpponentsFor(builder.key)).usernameAllowanceLeft;
      const shared = async () => (await w.lobbies.listChallengeOpponents()).allowanceLeft;
      const fresh = [await left(), await shared()];
      const { requestId, lobbyId } = value(await w.lobbies.requestChallenge(builder.key, `antwars/${HANDLE}`));
      expect([await left(), await shared()]).toEqual([fresh[0]! - 1, fresh[1]! - 1]);
      return { w, house, seat, builder, requestId, lobbyId, allowances: async () => [await left(), await shared()], fresh };
    }

    it("closes the lobby, reads expired with reason builder_left for builder and owner, and charges nothing", async () => {
      const { w, house, builder, requestId, lobbyId, allowances, fresh } = await challenged();
      expect(value(await w.lobbies.leave(lobbyId, builder.key))).toMatchObject({ state: "ended", outcome: "not_played", startsAt: null, challenge: { kind: "house" } });
      expect(await allowances()).toEqual(fresh);
      expect(value(await w.lobbies.challengeStatus(builder.key, requestId))).toEqual({ requestId, lobbyId, handle: `antwars/${HANDLE}`, state: "expired", reason: "builder_left" });
      expect(value(await w.lobbies.challengeStatus(house.key, requestId))).toEqual({
        requestId, lobbyId, handle: `antwars/${HANDLE}`, state: "expired", reason: "builder_left", launchReport: null, launchReportReason: null });
      // The builder's latest challenge, read without an id.
      expect(value(await w.lobbies.challengeStatus(builder.key))).toMatchObject({ state: "expired", reason: "builder_left" });
      expect((await w.raw(`challengeRequests/${requestId}`))!.builderLeft).toBe("true");
    });

    it("still reads expired with reason builder_left once the emptied lobby is removed", async () => {
      const { w, house, builder, requestId, lobbyId, allowances, fresh } = await challenged();
      value(await w.lobbies.leave(lobbyId, builder.key));
      await w.remove(`lobbies/${lobbyId}`);
      expect(await w.raw(`lobbies/${lobbyId}`)).toBeNull();
      expect(value(await w.lobbies.challengeStatus(builder.key, requestId))).toEqual({ requestId, lobbyId, handle: `antwars/${HANDLE}`, state: "expired", reason: "builder_left" });
      expect(value(await w.lobbies.challengeStatus(house.key, requestId))).toEqual({
        requestId, lobbyId, handle: `antwars/${HANDLE}`, state: "expired", reason: "builder_left", launchReport: null, launchReportReason: null });
      expect(value(await w.lobbies.reportChallengeLaunch(house.key, requestId, "launched"))).toEqual({ requestId, launchReport: "launched", state: "expired" });
      expect(value(await w.lobbies.challengeStatus(builder.key, requestId))).toMatchObject({ state: "expired", reason: "builder_left" });
      expect(await allowances()).toEqual(fresh);
    });

    it("never reads finished, nor charges, after a launched report; the held seat cannot be taken", async () => {
      const { w, house, seat, builder, requestId, lobbyId, allowances, fresh } = await challenged();
      value(await w.lobbies.leave(lobbyId, builder.key));
      expect(value(await w.lobbies.reportChallengeLaunch(house.key, requestId, "launched"))).toEqual({ requestId, launchReport: "launched", state: "expired" });
      expect(reasonOf(await w.lobbies.join(lobbyId, seat.key))).toBe("started");
      for (const reader of [builder, house]) {
        const status = value(await w.lobbies.challengeStatus(reader.key, requestId));
        expect([status.state, status.reason]).toEqual(["expired", "builder_left"]);
      }
      expect(await allowances()).toEqual(fresh);
      // A new challenge is admitted at once: the left one is no longer active.
      value(await w.lobbies.requestChallenge(builder.key, `antwars/${HANDLE}`));
    });

    it("marks no request when a seat other than the builder's last one leaves a player lobby", async () => {
      const { w, builder, requestId } = await challenged();
      const { lobby } = value(await w.lobbies.createLobby(builder.key, "public", 1));
      const other = await w.claim("Bea");
      value(await w.lobbies.join(lobby.id, other.key));
      value(await w.lobbies.leave(lobby.id, other.key));
      expect((await w.raw(`challengeRequests/${requestId}`))!.builderLeft).toBeUndefined();
      expect(value(await w.lobbies.challengeStatus(builder.key, requestId)).state).toBe("waiting_for_house");
    });

    it("leaves a failed-launch close reading house_unavailable, and refuses the builder's later leave as started", async () => {
      const { w, house, builder, requestId, lobbyId } = await challenged();
      expect(value(await w.lobbies.reportChallengeLaunch(house.key, requestId, "failed", "player could not join")).state).toBe("house_unavailable");
      const closed = await w.raw(`lobbies/${lobbyId}`);
      expect(reasonOf(await w.lobbies.leave(lobbyId, builder.key))).toBe("started");
      expect(await w.raw(`lobbies/${lobbyId}`)).toEqual(closed);
      expect(value(await w.lobbies.challengeStatus(builder.key, requestId))).toMatchObject({ state: "house_unavailable", reason: "player could not join" });
    });
  });
});
