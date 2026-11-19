# Render evidence: parking Gemini 4 Neon low, medium and xhigh

- **Base:** 5634b8e8d037b56287219cdee9b3ff8407642a59 (main, `5634b8e` in file names). No Neon handle is retired there.
- **Head:** b0616bad986592cf11b9be216c8a071d707dcf95 (`b0616ba`), the pull request's head. gemini-4-neon-low, -medium and -xhigh are retired; gemini-4-neon-high is not.
- **Pages:** Matches, Leaderboard and the landing page, plus the replay HUD and the replay result screen (added below), at 1280 px and 390 px, in Roboto and Liberation Sans.
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

## Replay HUD and result screen

Two real finished Index 1v1 recordings of the Neon round robin, which together seat all four levels, rendered base and head on the 2D board:

| Recording | Players | Folder |
|---|---|---|
| 2026-11-19T12-14-45-958Z-234587808625478 | Gemini 4 Neon MEDIUM v HIGH | `<typeface>/replay-medium-v-high/` |
| 2026-11-19T11-55-01-554Z-154865995347872 | Gemini 4 Neon LOW v XHIGH | `<typeface>/replay-low-v-xhigh/` |

Two states per recording: **hud** (the replay playing near its start: score panel and the Agents list, where each line reads `Gemini 4 Neon (<level>)`) and **result** (seeked to the end, the head-to-head result dialog open: Players with level badge and rating). Files are `replay-<match>-2d-<state>-<build>-<width>.png`, with a crop of every Neon line beside it (`...-neon-<n>.png`). The recording, match and ratings answers were recorded from the public antwars.ai API 2026-11-19T13:15:39Z to 2026-11-19T13:19:09Z and replayed offline; page clock pinned at 2026-11-19T12:53:00Z. Rendered 2026-11-19T13:44:55Z to 2026-11-19T14:30:57Z.

What changes at head: the Agents line reads `(medium · retired)`, `(low · retired)`, `(xhigh · retired)`; the result dialog adds a RETIRED badge after the level. HIGH is unchanged in both. Ratings and rating changes are the same at base and head (MEDIUM 1380 (−53), HIGH 1774 (+54); XHIGH 1620 (+53), LOW 1226 (−54)).

On both recordings, both states, both widths, both typefaces, base and head: every Neon line is on one line and nothing is cut; no page errors; the result dialog opened every time. At 390 px the result dialog stacks PLAYERS over RATING and each rating under its player; base does the same.

Tightest fit per screen (head; spare = (available − needed) / available):

| Screen | Line | Typeface | Width | Spare | Base, same line |
|---|---|---|---|---|---|
| Replay HUD, Agents list | Gemini 4 Neon (medium · retired) | Liberation Sans | 1280 | 35.0% | 51.2% (no "· retired") |
| Replay HUD, Agents list | same | Roboto | 1280 | 35.6% | 51.4% |
| Result dialog, Players | Gemini 4 Neon MEDIUM RETIRED | Liberation Sans and Roboto | 390 | 22.3% | 46.9% (no badge) |
| Result dialog, Players | Gemini 4 Neon XHIGH RETIRED | both | 390 | 26.2% | 50.8% |

No replay line comes under the 8% mark used above. Per-line measurements are in `<typeface>/replay-measurements.json` (one entry per recording, build and width). For the MEDIUM v HIGH recording at 1280 px the full run record was not written because the run was stopped after that unit; its entry is the run's printed per-line summary (text, lines, cut, spare), and its screenshots are complete.

## Data and method

- **Builds:** `git archive` of each commit, built with `vite build --config web/vite.config.ts`.
- **Browser:** Playwright with chrome-headless-shell build 1254, every request routed offline. Viewports were 1280x800 and 390x844 (mobile, touch).
- **Replay method:** the same builds and browser; each replay loaded with `?replay=<id>&board=2d`, played about 20 s for the HUD, then seeked to the end through the replay slider until the result dialog opened. The 3D board was not rendered.
- **Files:** each page is at `<typeface>/<page>/<page>-<build>-<width>.png`, with its Neon row crops beside it. Measurements are in `<typeface>/measurements.json`: per page, the Recordings and player-cell probes, the Neon rows, the padding and item checks, and the typeface the browser reported for each text part.
