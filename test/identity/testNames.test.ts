import { expect, it } from "vitest";
import { parseName } from "../../src/identity/identities.js";
import { TEST_NAME_WORDS, testUsername } from "../../src/identity/testNames.js";

it("every possible test name is readable complete words and a valid username, without suffixes", () => {
  for (const words of TEST_NAME_WORDS) {
    expect(words.length).toBeGreaterThan(1);
    expect(new Set(words).size).toBe(words.length);
    for (const word of words) expect(word).toMatch(/^[a-z]+$/);
  }
  for (let first = 0; first < TEST_NAME_WORDS[0]!.length; first++) {
    for (let second = 0; second < TEST_NAME_WORDS[1]!.length; second++) {
      for (let third = 0; third < TEST_NAME_WORDS[2]!.length; third++) {
        const indices = [first, second, third];
        const name = testUsername(() => indices.shift()!);
        expect(name).toBe([TEST_NAME_WORDS[0]![first], TEST_NAME_WORDS[1]![second], TEST_NAME_WORDS[2]![third]].join("-"));
        expect(parseName(name)?.display).toBe(name);
      }
    }
  }
});

it("default randomness chooses from the same word vocabulary", () => {
  for (let i = 0; i < 100; i++) {
    const parts = testUsername().split("-");
    expect(parts).toHaveLength(3);
    parts.forEach((word, index) => expect(TEST_NAME_WORDS[index]).toContain(word));
  }
});
