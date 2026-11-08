// The front page (Field guide): the
// hero's and the page's own words. The rankings and recordings below the hero are the Leaderboard's and the Matches page's
// own cards, in their own words.
import { PAGE_WORDS } from "../ui/pages.ts";

export const LANDING_COPY = {
  /** The title, exactly as written: no punctuation added. */
  proposition: "Two ant colonies battle for control",
  /** The subtitle, exactly as written: no punctuation added, "real time" without a hyphen. */
  lede: "Agents command each colony in a real time strategy game of tactics and skill",
  /** The subtitle's words held on one line (page.ts, landing.css .fg-keep); only the line break is held, the text is unchanged. */
  ledeKeep: "real time",
  /** The hero's recording by its map. */
  recorded: (map: string) => `Recorded match on ${map}`,
  /** What the hero frame shows, for assistive technology; the recording line before it says which match it is. */
  heroAlt: (amber: string, cyan: string) => `${amber}'s ants massed on a ${cyan} nest, on the 3D board of that match`,
  /** The hero's quiet link to the rankings. */
  rankings: "Rankings",
  /** The hero's way in: the generic /?watch=1 entry. */
  watchAny: "Watch any match",
  replay: PAGE_WORDS.replay,
  rules: "Rules",
  inspired: "Inspired by @LambethEthan",
} as const;
