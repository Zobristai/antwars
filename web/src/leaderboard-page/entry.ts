import { dispatchPage } from "./route.ts";

void dispatchPage(new URL(window.location.href), {
  leaderboard: async () => {
    const { mountLeaderboardPage } = await import("./page.ts");
    mountLeaderboardPage(document, window);
  },
  matches: async () => {
    const { mountMatchesPage } = await import("../matches-page/page.ts");
    mountMatchesPage(document, window);
  },
  landing: async () => {
    const { mountLandingPage } = await import("../landing-page/page.ts");
    mountLandingPage(document, window);
  },
  spectator: () => import("../main.ts"),
});
