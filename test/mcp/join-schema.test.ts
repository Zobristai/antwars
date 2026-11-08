import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { rootJoinSchema, slotJoinSchema, unknownFields } from "../../src/mcp/tools.js";
import { TEST_MCP_CONFIG, startHarness, type Harness } from "./harness.js";

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const RESEND = "Resend the call with these fields corrected.";

// The root join's refusal text, pinned byte for byte, so deriving its fields from its schema changes no reply.
describe("root join refusal text", () => {
  it("names every wrong-typed field with its expected type", async () => {
    h = await startHarness();
    const agent = await h.connect();
    const messages: Record<string, [unknown, string]> = {
      reconnectToken: [1, "reconnectToken must be a string: the reconnectToken join gave you."],
      token: [2, "token must be a string: alias for reconnectToken."],
      displayName: [3, "displayName must be a string."],
      modelLabel: [4, "modelLabel must be a string."],
      thinkingLevel: [5, "thinkingLevel must be a string."],
      colony: ["Tiny Colony", 'colony must be one of "Very Large Colony", "Lake Hodges Colony".'],
    };
    for (const [field, [value, message]] of Object.entries(messages)) {
      const one = await agent.call("join", { [field]: value });
      expect(one.data.error).toEqual({ code: "bad_arguments", message, howToFix: RESEND });
    }
    const all = await agent.call("join", Object.fromEntries(Object.entries(messages).map(([field, [value]]) => [field, value])));
    expect(all.data.error).toEqual({ code: "bad_arguments", message: Object.values(messages).map(([, m]) => m).join(" "), howToFix: RESEND });
  });

  it("refuses unknown fields by name", async () => {
    h = await startHarness();
    const r = await (await h.connect()).call("join", { displayName: "Ann", bogus: 1, seat: 2 });
    expect(r.data.error).toEqual({
      code: "bad_arguments",
      message: 'Unknown join arguments: "bogus", "seat".',
      howToFix: 'Remove unknown arguments: "bogus", "seat". Use reconnectToken to rejoin; token is its alias.',
    });
  });

  it("advertises the same input schema", async () => {
    h = await startHarness();
    const join = (await (await h.connect()).client.listTools()).tools.find((tool) => tool.name === "join")!;
    expect(join.inputSchema).toMatchInlineSnapshot(`
      {
        "$schema": "http://json-schema.org/draft-07/schema#",
        "additionalProperties": {},
        "properties": {
          "colony": {
            "default": null,
            "description": "Optional colony to join; honoured below the 4-agent colony limit, otherwise refused. Omit to balance.",
            "enum": [
              "Very Large Colony",
              "Lake Hodges Colony",
            ],
            "type": "string",
          },
          "displayName": {
            "default": null,
            "description": "Optional display name.",
            "type": "string",
          },
          "modelLabel": {
            "default": null,
            "description": "Optional self-reported model label, shown to spectators.",
            "type": "string",
          },
          "reconnectToken": {
            "default": null,
            "description": "Your reconnectToken, to rejoin as the same agent from any session.",
            "type": "string",
          },
          "thinkingLevel": {
            "default": null,
            "description": "Optional self-reported thinking level, 1 to 32 printable characters; recorded with your seat, never inferred.",
            "type": "string",
          },
          "token": {
            "default": null,
            "description": "Alias for reconnectToken. If both are sent, their values must match.",
            "type": "string",
          },
        },
        "type": "object",
      }
    `);
  });
});

// Each join accepts exactly its schema's fields, so a field added to a schema needs no other edit.
describe("join fields come from the join schemas", () => {
  it("accepts a field added to either schema and still refuses fields outside it", () => {
    for (const schema of [rootJoinSchema(TEST_MCP_CONFIG), slotJoinSchema(TEST_MCP_CONFIG)]) {
      const args = { ...Object.fromEntries(Object.keys(schema.shape).map((name) => [name, "x"])), team: "red", bogus: 1 };
      expect(unknownFields(schema, args)).toEqual(["team", "bogus"]);
      expect(unknownFields(schema.extend({ team: z.string().optional() }), args)).toEqual(["bogus"]);
    }
  });
});
