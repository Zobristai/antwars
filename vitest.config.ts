// Base config: `npm run test:full` runs every test with it, and
// vitest.essential.config.ts extends it. Its only change to vitest's defaults
// is the emulator guard (scripts/ci/emulator-guard.ts).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["scripts/ci/emulator-guard.ts"],
  },
});
