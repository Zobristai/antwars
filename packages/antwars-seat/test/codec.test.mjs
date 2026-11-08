// The seat codec is generated from the server's reference decoders; the conformance fixtures
// pin the wire format both sides (and any outside implementation) decode.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { denseCells, expandCells as serverExpandCells } from "../../../src/sim/view.ts";
import { packTerritory, unpackTerritory as serverUnpackTerritory } from "../../../src/mcp/territory.ts";
import { packMarks, unpackMarks as serverUnpackMarks } from "../../../src/mcp/markTable.ts";
import { renderSeatCodec, SEAT_CODEC_PATH } from "../../../scripts/generate-seat-codec.ts";
import * as seat from "../lib/codec.generated.mjs";

const FIXTURES = JSON.parse(readFileSync(new URL("../../../test/fixtures/seat-codec/conformance.json", import.meta.url), "utf8"));

const DECODERS = {
  cells: { server: serverExpandCells, seat: seat.expandCells },
  territory: { server: serverUnpackTerritory, seat: seat.unpackTerritory },
  marks: { server: serverUnpackMarks, seat: seat.unpackMarks },
};

describe("generated seat codec", () => {
  it("equals the generator's output from the current server source (npm run seat-codec when stale)", () => {
    expect(readFileSync(SEAT_CODEC_PATH, "utf8")).toBe(renderSeatCodec());
  });
});

describe("conformance fixtures", () => {
  it("the server encoders reproduce every encoded payload", () => {
    for (const { encoded, decoded } of FIXTURES.cells) expect(denseCells(decoded, encoded.width, encoded.height)).toEqual(encoded);
    for (const { encoded, decoded } of FIXTURES.territory) expect(packTerritory(decoded, encoded.width, encoded.height)).toEqual(encoded);
    for (const { encoded, decoded } of FIXTURES.marks) if (!Array.isArray(encoded)) expect(packMarks(decoded)).toEqual(encoded);
  });

  for (const [kind, decoders] of Object.entries(DECODERS)) {
    for (const [side, decode] of Object.entries(decoders)) {
      it(`${side} ${kind} decoder returns every fixture's decoded value and refuses every invalid payload`, () => {
        expect(FIXTURES[kind].length).toBeGreaterThan(0);
        for (const { name, encoded, decoded } of FIXTURES[kind]) expect(decode(encoded), name).toEqual(decoded);
        expect(FIXTURES[`${kind}Invalid`].length).toBeGreaterThan(0);
        for (const { name, encoded } of FIXTURES[`${kind}Invalid`]) expect(() => decode(encoded), name).toThrow();
      });
    }
  }
});
