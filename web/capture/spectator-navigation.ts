import type { Page } from "playwright-core";

/** The retired Lobbies & keys button/dialog and the public matches panel. */
export const RETIRED_CHROME = "#aw-lobby-controls, .aw-lobby-open, #aw-match-directory";

/** Observe the real product; a watch page never mounts the retired lobby or directory chrome. */
export async function assertNoRetiredChrome(page: Pick<Page, "locator">): Promise<void> {
  if ((await page.locator(RETIRED_CHROME).count()) !== 0) throw new Error("A watch page shows retired lobby or directory chrome");
}
