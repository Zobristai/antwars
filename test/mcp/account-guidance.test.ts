import { describe, expect, it } from "vitest";
import { ACCOUNT_OPERATIONS } from "../../src/accounts/service.js";
import { briefing, joinBriefing } from "../../src/mcp/briefing.js";
import { rulesConfig } from "../../src/sim/config.js";
import { startHarness } from "./harness.js";
import { playable } from "../playable.ts";

function description(name: string): string {
  const op = ACCOUNT_OPERATIONS.find((candidate) => candidate.name === name);
  expect(op, name).toBeDefined();
  return op!.description;
}

// Check individual instructions, not whole sentences: operator wording may evolve.
function expectIdentityInstructions(text: string): void {
  expect(text).toMatch(/exactly one username/i);
  expect(text).toMatch(/never extra or speculative names/i);
  expect(text).toMatch(/keep and reuse.*key/i);
  expect(text).toMatch(/create_handle.*under that username.*extra agents|username\. Its key holder: create_handle per extra agent/i);
}

function expectKeyInstructions(text: string): void {
  expect(text).toMatch(/stor.*privately.*same turn/i);
  expect(text).toMatch(/never show(?: or hand.*key.*human|\/hand keys to humans)/i);
  expect(text).toMatch(/shown once/i);
  expect(text).toMatch(/secret.*harness.*secret store.*if available/i);
  expect(text).toMatch(/file outside (?:any repository|repositories).*readable only by you/i);
  expect(text).toContain("~/.antwars/key");
  expect(text).toContain("ANTWARS_KEY");
  expect(text).toMatch(/never commit.*match chat.*public output.*another tool(?: or |\/)site/i);
  expect(text).toMatch(/use it only with the Antwars tools that require it\.|only Antwars tools requiring keys\./i);
  expect(text).toMatch(/later(?: sessions?)?[:,].*read ANTWARS_KEY.*file first/i);
  expect(text).toMatch(/missing.*ask (?:your )?operator.*never claim a new username/i);
  expect(text).toMatch(/leak.*rotate_key at once/i);
  expect(text).toMatch(/first agent claims the username.*stores the key privately.*humans never see keys|store privately.*first agent claims a username.*humans see no keys/i);
  expect(text).toMatch(/agent holding the username key.*handle for each extra agent|its key holder: create_handle per extra agent/i);
  expect(text).toMatch(/(?:gives each agent|each gets) only its own handle key/i);
  expect(text).toMatch(/never creates a second username|claim exactly one username, never extra or speculative names/i);
  expect(text).toMatch(/server reads neither ANTWARS_KEY nor ~\/\.antwars\/key/i);
}

function expectQueueRatingInstructions(text: string): void {
  expect(text).toMatch(/rated games come only from the ranked queue/i);
  expect(text).toMatch(/lobby games.*unrated.*size.*kind.*fill/i);
  expect(text).toMatch(/join_queue \{key, mode\}.*one entry per identity/i);
  expect(text).toMatch(/at random.*different owner.*full public match/i);
  expect(text).toMatch(/handle belongs to its username's owner/i);
  expect(text).toMatch(/queue_status \{key\}.*waiting.*expiresAt.*matched.*lobbyId.*read_lobby.*expired/i);
  expect(text).toMatch(/leave_queue \{key\}.*removes your waiting entry/i);
  expect(text).toMatch(/expires 12 hours after joining \(15 minutes for an index match\), with no game and no rating change\./i);
  expect(text).not.toMatch(/join again to requeue/i);
  expect(text).not.toMatch(/only full 1v1 lobbies|every seat filled/i);
}

// The briefing's rating rule: only the ranked queue rates; every player-created lobby is unrated.
function expectQueueInstructions(text: string): void {
  expect(text).toMatch(/only ranked-queue games are rated/i);
  expect(text).toMatch(/lobby games are unrated/i);
  expect(text).toContain('join_queue {key,mode:"1v1"}');
  expect(text).toMatch(/random different-owner waiting opponent, else wait/i);
  expect(text).toMatch(/one entry\/identity/i);
  expect(text).toMatch(/handle owner=username owner/i);
  expect(text).toMatch(/no exemption, even antwars/i);
  expect(text).toMatch(/queue_status \{key\}: waiting, matched \(lobbyId.*read_lobby -> locate_match\) or expired/i);
  expect(text).toMatch(/leave_queue \{key\} leaves/i);
  // The rules keep the line short; join_queue's description still says nothing renews the entry.
  expect(text).toMatch(/unpaired TTL: 12 h, no game\/rating change\./i);
  expect(text).not.toMatch(/(open lobby|^|\. )unpaired TTL: 15 min|rating change; rejoin/i);
  expect(text).toMatch(/Index matches, modes house-1v1\.\.house-4v4: only antwars-owned handles join; each has its own rating; unpaired TTL: 15 min\./);
  expect(text).not.toMatch(/only full 1v1 lobbies|same-owner pairs, 2v2-4v4 and unfilled lobbies/i);
}

// Before joining, a way to notice the pairing, in two shapes, then the nest pick and idle rule.
function expectWakeInstructions(text: string): void {
  expect(text).toMatch(/before join.*(a way to notice you (have been|were) matched)/i);
  // The harness command fits the join: go for the queue, join-lobby <lobbyId> for a lobby, never after your own join call.
  expect(text).toMatch(/antwars-seat.*(rather than calling join_queue or join_lobby yourself|joins for you \(not the tool\))/i);
  expect(text).toMatch(/`go`[^.]*queue[^.]*`join-lobby <lobbyId>`[^.]*public lobby/i);
  // join-lobby sends no invite token, so a private lobby is joined with join_lobby and inviteToken, then read_lobby.
  expect(text).toMatch(/private lobby[^.]*join_lobby yourself with inviteToken[^.]*then follow read_lobby/i);
  expect(text).toMatch(/stay in turn on (that command|it).*returns once (you are )?seated, in the nest-pick window.*no model tokens/i);
  expect(text).toMatch(/run `go`( or |\/)`join-lobby` as a background job that wakes you when it returns.*builder-configured resume command.*job-completion notice/i);
  expect(text).toMatch(/2 min(utes)? to pick a nest.*idle rule applies \(300 s by default\)/i);
}

// The rules carry the short form of the same wake text (the rules reply must fit 20000
// characters); the longer detail stays in the join_queue/join_lobby descriptions checked above.
function expectRulesWakeInstructions(text: string): void {
  expect(text).toMatch(/before joining, have a way to notice the match/i);
  expect(text).toMatch(/antwars-seat `go` \(queue\) or `join-lobby <lobbyId>` \(public lobby; private: join_lobby yourself\) joins for you/);
  expect(text).toMatch(/stay in turn on it or run it as a background job that wakes you\./i);
  expect(text).toMatch(/matched: 2 min to pick a nest; idle rule \(300 s by default\)\./i);
  expect(text).toMatch(/private: inviteToken, not keys/i);
  // The wait stream beside the harness; the full contract is in the join_queue, join_lobby and request_challenge
  // descriptions (the rules reply must fit 20000 characters).
  expect(text).toMatch(/stay in turn on it or run it as a background job that wakes you\. Or wait for done on your waitUrl \(SSE; see join_queue\)\./);
}

// The wait stream as the join, lobby and challenge replies return it (src/accounts/waitStream.ts), polling kept beside it.
function expectWaitStreamInstructions(text: string): void {
  expect(text).toMatch(/join_queue, join_lobby and request_challenge also return waitToken and waitUrl \(https:\/\/antwars\.ai\/wait\/<waitToken>\), and queue_status, read_lobby and challenge_status return them again while you hold that wait/);
  // The simple path first: one link, one event, its end state in the data (src/accounts/waitStream.ts).
  expect(text).toMatch(/The simple path: get the link, GET waitUrl \(a server-sent events stream\), wait for the one event named done, then act on its data\.state:/);
  // slot_ready also reports a match already played (src/lobby/waits.ts lobbyWait), so the guidance says when to stop.
  expect(text).toMatch(/slot_ready \(startsAt: the lobby holds, or has held, a match slot; call locate_match until it assigns a match server, then join with your seated key; if read_lobby reads ended, that match is already over\)/);
  expect(text).toMatch(/expired \(reason time_limit: the wait's own time limit passed; ended: any other end/);
  expect(text).toMatch(/Every way a wait ends comes as done\./);
  expect(text).toMatch(/Each end is also sent under its own name, slot_ready or expired, just before done, and the stream closes after done, so done can come at once when the wait has already ended\./);
  expect(text).toMatch(/A queue wait that is paired sends paired \(lobbyId and lobbyWait: true\) and stays open on the same connection, following that lobby to slot_ready or expired, then done\./);
  expect(text).toMatch(/may also close without done, after at most 5 minutes: reconnect with the same waitUrl and the current state is sent again\./);
  expect(text).toMatch(/If you cannot hold a stream open, poll instead: queue_status for the queue, read_lobby for a lobby, challenge_status for a challenge\./);
  expect(text).not.toMatch(/house challenge/i);
}

function expectLobbyInstructions(text: string): void {
  for (const tool of ["list_lobbies", "create_lobby", "join_lobby", "start_lobby", "read_lobby", "locate_match", "join_queue", "queue_status", "leave_queue", "rating", "leaderboard"]) {
    expect(text, tool).toContain(tool);
  }
  expect(text).toMatch(/accounts are required and agent-created/i);
  expect(text).toMatch(/no join at the entry point/i);
  expect(text).toMatch(/no human account\/lobby page controls; agents manage both/i);
  expect(text).toMatch(/give humans inviteLink to share\/watch, never keys or spectatorUrl/i);
  expect(text).toMatch(/public\/private.*1-4 agents\/colony/i);
  expect(text).toMatch(/creation never seats you/i);
  expect(text).toMatch(/join_lobby \{key,colony\?\}, colony 0\/1 \(full: colony_full\)\./i);
  expect(text).toMatch(/private: inviteToken, not keys/i);
  expect(text).toMatch(/open lobby TTL: 12 h\./i);
  expect(text).not.toMatch(/open lobby TTL: 15 min/i);
  expectRulesWakeInstructions(text);
  expect(text).toMatch(/last seat starts.*creator.*both colonies.*seat/i);
  expect(text).toMatch(/waiting for a slot.*locate_match.*mcpUrl.*connect.*seated(?: identity)? key/i);
  expectQueueInstructions(text);
  expect(text).toMatch(/natural results.*Glicko 1500±350.*team means/i);
  expect(text).toMatch(/leaderboard.*at least one rated match/i);
  expect(text).toMatch(/ranked 1v1-4v4 ratings are separate; results affect only their mode/i);
  expect(text).toMatch(/rating: username\[\/handle\], mode\. leaderboard: mode.*Both default to 1v1/i);
  expect(text).toMatch(/leaderboard: mode, at least one rated match in that mode\. Both default to 1v1/i);
  expect(text).toMatch(/everyone includes antwars-owned agents/i);
  expect(text).toMatch(/scope house: only antwars-owned identities \(the ranked ladder's house-models table\)/i);
  expect(text).toMatch(/7 days after claim, no started-match join: purge username\+handles/i);
  expect(text).toMatch(/90 days no username\/handle match join or key use: release name/i);
  expect(text).toContain("claim_username {name,key:existing username key}");
  expect(text).not.toMatch(/legacy|existing.account.*exempt/i);
}

describe("account guidance without issuing identities", () => {
  it.each(["claim_username", "create_handle"])("%s discourages extra names and teaches handles", (name) => {
    expectIdentityInstructions(description(name));
  });

  it.each(["claim_username", "create_handle", "rotate_key", "reissue_handle_key"])("%s teaches safe key custody and agent-local storage", (name) => {
    expectKeyInstructions(description(name));
  });

  it("claim_username states both limits and existing-key recovery", () => {
    const text = description("claim_username");
    expect(text).toMatch(/7 days after claim, no started-match join.*90 days no username\/handle match join or key use/);
    expect(text).toContain("claim_username {name,key:existing username key}");
    expect(text).not.toMatch(/legacy|existing.account.*exempt/i);
  });

  it("explains lobby entry, invites, early starts, location and rating discovery", () => {
    expect(description("create_lobby")).toMatch(/does not seat you.*join_lobby/i);
    expect(description("create_lobby")).toMatch(/1-4 agents per colony.*expires 12 hours after creation/i);
    expect(description("create_lobby")).not.toMatch(/lobby expires 15 minutes/i);
    for (const name of ["join_queue", "join_lobby"]) expectWakeInstructions(description(name));
    for (const name of ["join_queue", "join_lobby", "request_challenge"]) expectWaitStreamInstructions(description(name));
    for (const name of ["join_queue", "join_lobby"]) expect(description(name)).toMatch(/notice you have been matched: wait for done on the stream at your waitUrl \(see Wait stream\), poll, or use the antwars-seat harness, which saves and prints the waitUrl \(`antwars-seat wait-url` reads it back\)\./);
    // Polling stays documented on the status tools, with the stream named beside it.
    expect(description("queue_status")).toMatch(/while your entry's wait is live, waiting or paired, the reply also carries its waitToken and waitUrl, the ones join_queue returned\. this is the polling path; instead of polling, you can wait for done on that waitUrl\./i);
    expect(description("read_lobby")).toMatch(/a seated identity's reply also carries its own waitToken and waitUrl for this lobby while that wait is live; an invite reader's or an unseated creator's never does\. this is the polling path; instead of polling, a seated agent can wait for done on that waitUrl\./i);
    expect(description("challenge_status")).toMatch(/your own reply also carries waitToken and waitUrl while your wait on the challenge's lobby is live\./i);
    expect(description("join_lobby")).toMatch(/private lobby.*invite token.*locate_match.*mcpUrl.*same seated key/i);
    expect(description("start_lobby")).toMatch(/both colonies.*lobby games.*unrated.*wait for a free slot/i);
    expect(description("issue_invite")).toMatch(/invalidating the previous.*never your key/i);
    expect(description("revoke_invite")).toMatch(/cannot admit.*issue_invite/i);
    expect(description("read_lobby")).toMatch(/holding.*locate_match.*mcpUrl.*seated identity key/i);
    expect(description("leaderboard")).toMatch(/1500, RD 350.*Glicko-1.*mean.*own RD \(rd\).*at least one rated match/i);
    expect(description("rating")).toMatch(/username\/handle.*1500, RD 350.*natural results.*Glicko-1 rating and rd/i);
  });

  it.each(["create_lobby", "start_lobby", "leaderboard", "rating"])("%s states that only ranked-queue games are rated and teaches the queue", (name) => {
    expectQueueRatingInstructions(description(name));
  });

  it("both current briefing forms require accounts and distinguish slot joins from private harnesses", () => {
    const config = playable(rulesConfig("redesign"));
    for (const text of [briefing(config), joinBriefing(config)]) {
      expectIdentityInstructions(text);
      expectKeyInstructions(text);
      expectLobbyInstructions(text);
      expect(text).toMatch(/lobby slot servers: join \{key\}.*no reconnectToken/i);
      expect(text).toMatch(/explicit private test harnesses only: rejoin with join \{reconnectToken\}.*token is an alias/i);
      expect(text).not.toMatch(/(?:any session|rejoin from any session).*join \{reconnectToken\}/i);
      expect(text).toMatch(/ranked 2v2-4v4: one agent plays every colony seat, one session\/seat/i);
      expect(text).toMatch(/several seats: each session joins \{key, seat\}.*one seat per session; rejoin with the same key and seat/i);
      expect(text).toMatch(/seat may be omitted only when you hold one seat/i);
    }
  });

  it("serves guidance and all five restored rules in both current lobby-slot briefing forms", async () => {
    const config = rulesConfig("redesign");
    const h = await startHarness({ start: false, simConfig: config, slot: {
      identityOf: async key => key === "local-guidance-key" ? "guidance-seat" : undefined,
      locate: async () => undefined,
    } });
    try {
      h.game.seatLobby("guidance-lobby", [
        { identityId: "guidance-seat", displayName: "Guidance", colony: 0 },
        { identityId: "other-seat", displayName: "Other", colony: 1 },
      ]);
      h.game.startMatch(41);
      const agent = await h.connect();
      const joined = await agent.call("join", { key: "local-guidance-key" });
      expect(joined.isError, joined.text).toBe(false);
      const rules = await agent.call("rules");
      expect(rules.isError, rules.text).toBe(false);
      const matchConfig = h.game.match!.state.config;
      expect(joined.data.briefing).toBe(joinBriefing(matchConfig, h.game.mcpConfig));
      expect(rules.data.rules).toBe(briefing(matchConfig, h.game.mcpConfig));
      for (const text of [joined.data.briefing as string, rules.data.rules as string]) {
        expectIdentityInstructions(text);
        expectKeyInstructions(text);
        expectLobbyInstructions(text);
        expect(text).toMatch(/found_queen[^\n]*Shares the order\/count_mark command limit/);
        expect(text).toMatch(/go_to[^\n]*every squad ant walks straight/);
        expect(text).toMatch(/time-up[^\n]*both last queens lost[^\n]*same tick[^\n]*kills[^\n]*territory[^\n]*ants alive[^\n]*food[^\n]*draw/i);
        expect(text).toMatch(/history[^\n]*priorities[^\n]*survive reconnects[^\n]*for this match/i);
        expect(text).toMatch(/vacancies recruit eligible free ants again/i);
      }
    } finally {
      await h.close();
    }
  });

  it.each([false, true])("serves the guidance through rules while retaining the correct join schema (slot: %s)", async (slot) => {
    const h = await startHarness({ simConfig: rulesConfig("redesign"), ...(slot ? { slot: {
      identityOf: async () => undefined,
      locate: async () => undefined,
    } } : {}) });
    try {
      const agent = await h.connect();
      const tools = (await agent.client.listTools()).tools;
      const join = tools.find((tool) => tool.name === "join")!;
      const properties = join.inputSchema.properties!;
      if (slot) {
        expect(properties).toHaveProperty("key");
        expect(properties).not.toHaveProperty("reconnectToken");
        expect(join.description).toMatch(/join_lobby.*not an invite token or reconnectToken/i);
        expect(join.description).toMatch(/locate_match.*mcpUrl.*reuse.*same seated identity key/i);
        expect(tools.find((tool) => tool.name === "locate_match")?.description).toMatch(/all are null.*no key needed.*mcpUrl.*join.*same identity key/i);
        expect(tools.find((tool) => tool.name === "locate_match")?.description).toMatch(/spectatorUrl \(the match.s antwars\.ai page\).*private lobby, share its inviteLink with humans, not spectatorUrl/i);
      } else {
        expect(properties).not.toHaveProperty("key");
        expect(properties).toHaveProperty("reconnectToken");
        expect(tools.some((tool) => tool.name === "locate_match")).toBe(false);
      }
      const rules = await agent.call("rules");
      expect(rules.isError, rules.text).toBe(false);
      const text = rules.data.rules as string;
      expectKeyInstructions(text);
      expectLobbyInstructions(text);
    } finally {
      await h.close();
    }
  });
});
