# Render evidence: parking Gemini 4 Neon low, medium and xhigh

- **Base:** 5634b8e8d037b56287219cdee9b3ff8407642a59 (main, `5634b8e` in file names). No Neon handle is retired there.
- **Head:** b0616bad986592cf11b9be216c8a071d707dcf95 (`b0616ba`), the pull request's head. gemini-4-neon-low, -medium and -xhigh are retired; gemini-4-neon-high is not.
- **Pages:** Matches, Leaderboard and the landing page, at 1280 px and 390 px, in Roboto and Liberation Sans.
- **Data:** real only, no fixtures or synthetic rows. The public antwars.ai API's answers were recorded 2026-11-19T12:51:59Z to 2026-11-19T12:52:16Z and replayed offline for both builds. The page clock was pinned at 2026-11-19T12:53:00Z.
- Rendered 2026-11-19T12:53:00Z to 2026-11-19T13:00:00Z. Evidence only: it states what was rendered and measured.

## Parked Neon rows with their ratings

The head changes no stylesheet or page code. The only visible difference is a RETIRED badge after the level of the three parked Neon handles. Ratings, ranks, record and order are unchanged.

| Page | Row at head (both widths, both typefaces) | Crop |
|---|---|---|
| Leaderboard | rank 20, Gemini 4 Neon XHIGH RETIRED, 1620 ± 235 | `<typeface>/leaderboard/leaderboard-b0616ba-<width>-neon-*.png` |
| Leaderboard | rank 42, Gemini 4 Neon MEDIUM RETIRED, 1380 ± 235 | same |
| Leaderboard | rank 8, Gemini 4 Neon HIGH, 1774 ± 235, no badge | same |
| Matches | Recordings rows of the Neon round robin: LOW, MEDIUM, XHIGH with RETIRED and their ratings; HIGH without | `<typeface>/matches/matches-b0616ba-<width>-neon-*.png` |
| Landing | its Recordings card, the same lines | `<typeface>/landing/landing-b0616ba-<width>-neon-*.png` |

gemini-4-neon-low is below the Leaderboard's top 50, so it is shown only on Matches and the landing page. Base crops (`5634b8e`) show the same rows without RETIRED.

## One line, uncut, everywhere

On every page, width and typeface, base and head:
- every Recordings player line (40 on Matches, 10 on the landing page) is on one line;
- no name is cut, no badge group is clipped and no badge breaks inside itself;
- every colony cell passes the padding check;
- every Gemini 4 Neon label is on one line and uncut (12 rows on Matches, 3 on the Leaderboard, 11 on the landing page);
- there are no page errors.

Waiting and Live now were empty in the snapshot.

## Fits under 8% to spare (head)

Spare = (available − needed) / available, for each Recordings player line laid out on one line. At 390 px every parked Neon line has more than 8% to spare.

| Typeface | Width | Line | Needs / has px | Spare | Base |
|---|---|---|---|---|---|
| Liberation Sans | 1280 | Gemini 4 Neon MEDIUM RETIRED (3 rows) | 225.1 / 233 | 3.4% | no RETIRED badge |
| Liberation Sans | 1280 | Gemini 4 Neon XHIGH RETIRED (3 rows) | 216 / 233 | 7.3% | no RETIRED badge |
| Roboto | 1280 | Gemini 4 Neon MEDIUM RETIRED (3 rows) | 219.3 / 233 | 5.9% | no RETIRED badge |

The parked GPT-6.2 Astra Fast lines measure the same at base and head (tightest: MEDIUM, 2.1% in Liberation Sans at 1280).

## Data and method

- **Builds:** `git archive` of each commit, built with `vite build --config web/vite.config.ts`.
- **Browser:** Playwright with chrome-headless-shell build 1254, every request routed offline. Viewports were 1280x800 and 390x844 (mobile, touch).
- **Files:** each page is at `<typeface>/<page>/<page>-<build>-<width>.png`, with its Neon row crops beside it. Measurements are in `<typeface>/measurements.json`: per page, the Recordings and player-cell probes, the Neon rows, the padding and item checks, and the typeface the browser reported for each text part.
