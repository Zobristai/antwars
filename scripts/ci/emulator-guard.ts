// Emulator-gated suites use describe.skipIf(!FIRESTORE_EMULATOR_HOST),
// so a run without the Firestore emulator passes green while skipping them.
// With ANTWAR_REQUIRE_EMULATOR=1 (set by CI) such a run fails before any test.
export default function setup(): void {
  if (process.env.ANTWAR_REQUIRE_EMULATOR === "1" && !process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error(
      "ANTWAR_REQUIRE_EMULATOR=1 but FIRESTORE_EMULATOR_HOST is unset: the emulator-gated suites " +
        "would be skipped. Run through `npm test` / `npm run test:full` (firebase emulators:exec).",
    );
  }
}
