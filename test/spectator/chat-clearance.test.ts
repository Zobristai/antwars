import { describe, expect, it } from "vitest";
import { decodeMessage, encodePublicMessage } from "../../src/live/format.ts";
import { CHAT_VIEWPORTS, chatFixture, zoomState } from "../../web/capture/chat-clearance.ts";

describe("populated-chat clearance evidence", () => {
  it("covers exactly the five required sizes", () => {
    expect(CHAT_VIEWPORTS).toEqual([[1920, 1080], [1366, 768], [390, 844], [360, 780], [844, 390]]);
  });
  it("distinguishes hidden controls from covered controls and real clear targets", () => {
    expect(zoomState(false, false, false)).toBe("hidden");
    expect(zoomState(true, false, false)).toBe("covered");
    expect(zoomState(true, true, true)).toBe("covered");
    expect(zoomState(true, true, false)).toBe("visible and clear");
  });
  it("feeds public-wire agent words through continuous messages instead of replacing DOM text", () => {
    const messages = chatFixture().map(message => decodeMessage(encodePublicMessage(message)));
    expect(messages[0]!.full!.agents).toHaveLength(2);
    expect(messages[0]!.full!.agents.every(agent => agent.intent.length > 0)).toBe(true);
    expect(messages.flatMap(message => message.events).filter(event => event.kind === "order")).toHaveLength(12);
    expect(messages.map(message => message.tick)).toEqual(Array.from({ length: 81 }, (_, i) => 100 + i));
    expect(messages.slice(1).every(message => message.full === null)).toBe(true);
  });
});
