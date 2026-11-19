# Render evidence: parking Gemini 4 Neon low, medium and xhigh

- **Base:** 5634b8e8d037b56287219cdee9b3ff8407642a59 (main, `5634b8e` in file names). No Neon handle is retired there.
- **Head:** b0616bad986592cf11b9be216c8a071d707dcf95 (`b0616ba`), the pull request's head. gemini-4-neon-low, -medium and -xhigh are retired; gemini-4-neon-high is not.
- **Pages:** Matches, Leaderboard and the landing page, plus the replay HUD and the replay result screen on the 2D board and on the 3D board's deck (added below), at 1280 px and 390 px, in Roboto and Liberation Sans.
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
| Liberation Sans | 390 | 3D deck agent row at the end of a replay: Gemini 4 Neon XHIGH RETIRED 1567 WINNER (see the 3D section) | 332 / 360 | 7.8% | 25.1%, no RETIRED badge |

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
| Result dialog, Players | Gemini 4 Neon MEDIUM RETIRED | Liberation Sans | 390 | 22.3% | 46.9% (no badge) |
| Result dialog, Players | same | Roboto (drawn; see Drawn fonts) | 390 | 26.1% | 49.1% |
| Result dialog, Players | Gemini 4 Neon XHIGH RETIRED | Liberation Sans | 390 | 26.2% | 50.8% |
| Result dialog, Players | same | Roboto (drawn) | 390 | 30.0% | 53.0% |

No replay line comes under the 8% mark used above. Per-line measurements are in `<typeface>/replay-measurements.json` (one entry per recording, build and width). For the MEDIUM v HIGH recording at 1280 px the full run record was not written because the run was stopped after that unit; its entry is the run's printed per-line summary (text, lines, cut, spare), and its screenshots are complete.

## Replay on the 3D board: deck agent rows and result

The same two recordings with `board=3d`, base and head, 1280 px and 390 px, Roboto and Liberation Sans. On the 3D board each colony's deck shows its agent row: level badge, rating, and a WINNER badge once the match has ended. Folders are `<typeface>/replay-medium-v-high-3d/` and `<typeface>/replay-low-v-xhigh-3d/`, with files named `replay-<match>-3d-<state>-<build>-<width>.png` and a crop of every Neon line beside each.

Shots per recording: **hud** (playing near its start), **result** (seeked to the end, result dialog open; the deck rows are measured behind it). The low v xhigh recording also has **ended**: the same moment with the dialog closed by Escape, so that the deck rows are visible. That recording is the only one where a parked handle (xhigh) wins and so carries the WINNER badge beside RETIRED. In the medium v high recording the parked handle loses, and its row reads the same as during play. Rendered 2026-11-19T14:32:00Z to 2026-11-19T15:20:46Z, from the same recorded API answers.

What changes at head: the deck agent row adds a RETIRED badge after the level of LOW, MEDIUM and XHIGH. HIGH is unchanged. Ratings are unchanged. The result dialog is the same as on the 2D board.

On both recordings, every state, both widths, both typefaces, base and head: every Neon line is on one line and nothing is cut, there were no page errors, the dialog opened, and in the ended shots the dialog closed. At 390 px in the ended shots the board area above the controls is an empty tan field at base and at head alike. This is how this headless browser painted the 3D board after the dialog closed; the deck rows below the board are what these shots show.

Tightest fit per screen (head):

| Screen | Line | Typeface | Width | Spare | Base, same line |
|---|---|---|---|---|---|
| 3D deck row, during play | Gemini 4 Neon MEDIUM RETIRED 1433 | Liberation Sans | 390 | 22.1% | 39.5% |
| same | same | Roboto | 390 | 24.8% | 41.1% |
| 3D deck row, during play | Gemini 4 Neon XHIGH RETIRED 1567 | Liberation Sans | 390 | 24.8% | 42.2% |
| 3D deck row, ended | Gemini 4 Neon XHIGH RETIRED 1567 WINNER | Liberation Sans | 390 | **7.8%** (332 / 360 px) | 25.1% |
| same | same | Roboto | 390 | 11.3% | 27.5% |
| same | same | Liberation Sans | 1280 | 16.3% | 32.4% |
| Result dialog over the 3D board | Gemini 4 Neon MEDIUM RETIRED | Liberation Sans | 390 | 22.3% | 46.9% |
| same | same | Roboto (drawn; see Drawn fonts) | 390 | 26.1% | 49.1% |

The ended row with WINNER is the tightest line in this evidence. It still fits on one line, uncut, in both typefaces; crop: `liberation-sans/replay-low-v-xhigh-3d/replay-low-v-xhigh-3d-ended-b0616ba-390-neon-2.png`. Per-line measurements are in `<typeface>/replay-3d-measurements.json`: one entry per recording, build and width, each with every shot.

## After merging main into the pull request (new head 2e92b3e)

The pull request branch took main by a plain merge: **2e92b3eb17b9b70202fad92a5e993851fed6bd76** (`2e92b3e`) = b0616ba + main de76036b2ce28083227b3df454730a18897e44ef (`de76036`). Main brought two changes that touch where house handles are shown: the Recordings table on Matches and on the landing page (main #196), and the Watch page's Top matches tiles (main #199). This section compares **base de76036 (main) with head 2e92b3e**, so the only difference rendered is the parking itself.

**Recordings (Matches and the landing page's Recordings card): shown, rendered.** These lines show house-handle labels: model name plus level badge. Since main #196 a Recordings line no longer draws a RETIRED badge. A retired handle says it in the name's tooltip and in screen-reader text only (`web/src/pages/matches.ts` lines 699–711 at 2e92b3e: `const badges = { ...parts.badges, retired: false };`). So at head the parked Neon lines look the same as at base.

- Files: `<typeface>/merge-main/<page>/<page>-<build>-<width>.png` with Neon crops `...-neon-<n>.png`; measurements in `<typeface>/merge-main/measurements.json` (`recProbe` is every Recordings player line).
- Data: the public antwars.ai API answers recorded 2026-11-19T15:26:16Z to 2026-11-19T15:26:33Z (the same match list as the earlier snapshot), replayed offline; page clock 2026-11-19T15:27:00Z. Rendered 2026-11-19T15:27:00Z to 2026-11-19T15:31:00Z.
- Every Recordings player line (40 on Matches, 10 on the landing page) is on one line at both widths, in both typefaces, at base and head: no name is cut, no badge group is clipped or broken, and there are no page errors. No visible RETIRED badge is drawn on a Recordings line at head. The parked Neon lines carry ", retired" in screen-reader text and the tooltip.
- 81 of the 92 Neon crop pairs are byte-identical between base and head. The 11 that differ are all on the landing page at 390 px; the pair inspected (Roboto, crop 5) shows the same text, badges and layout.

Tightest Neon Recordings line (identical at base and head):

| Page | Typeface | Width | Line | Needs / has px | Spare |
|---|---|---|---|---|---|
| Matches | Liberation Sans | 1280 | Gemini 4 Neon MEDIUM 1433 | 171 / 211 | 18.9% |
| Matches | Roboto | 1280 | same | 169.1 / 212 | 20.2% |
| Matches | Liberation Sans | 390 | same | 171 / 231 | 26.0% |
| Landing | Liberation Sans | 1280 | same | 171 / 213 | 19.7% |

The tightest Recordings line of any kind is 4.2% (Liberation Sans) and 6.3% (Roboto) at 1280 on Matches, the same at base and head; it is not a Neon line.

**Top matches tiles: no parked handle shown, not rendered.** The tile draws the model and level badge but never the retired mark: `web/src/design-system/top-match-tile.ts` line 58 (`The retired mark is not drawn.`); the badge is built in lines 59–66, and the words at line 105 drop it (`badgeWords({ ...kinds, retired: false })`). None of the 16 matches in the shipped list (`src/replays/top-matches.json`) seats a Gemini 4 Neon handle: each match record was read from the public API on 2026-11-19, and the only Gemini 4 handles seated are Argon and Carbon. The page also cannot be rendered on real data yet, because antwars.ai does not serve `GET /matches/top` (404 on 2026-11-19).

## Drawn fonts in the replay captures

Every replay capture set was captured again with the browser's own report of the font it drew: for each element with its own text in the 2D Agents list (name and model lines), the 3D deck agent rows, and the result dialog's players (names and badges), the computed `font-family` and the platform fonts Chromium reports drawing that text with (DevTools protocol `CSS.getPlatformFontsForNode`, with glyph counts). A capture set is one recording, board, build (base 5634b8e or head b0616ba), width and typeface; each set has its HUD, result and ended shots. Same builds, browser, API snapshot and page clock as above; captured 2026-11-19T16:00:45Z to 2026-11-19T17:33:00Z. The replay code is unchanged from b0616ba to the current head 2e92b3e (`git diff b0616ba 2e92b3e -- web/src/ui` is empty).

**Finding: the Roboto result dialog was drawn in Liberation Sans.** The result dialog asks for `font-family: Arial, sans-serif` (`web/src/ui/deck/deck.css` line 556); everything else asks for the site stack that starts with `system-ui`. The Roboto setup mapped only `system-ui` and `sans-serif` to Roboto, so Arial fell to Liberation Sans, its metric equivalent. The Roboto rows for the result dialog in `roboto/replay-measurements.json` and `roboto/replay-3d-measurements.json` therefore measure Liberation Sans. The dialog was captured again with Arial also mapped to Roboto, as Android maps Arial to its sans-serif. That fit is listed above as "Roboto (drawn)". The dialog is wider there (26.1% at its tightest, against 22.3% in Liberation Sans), every line is on one line and uncut, and there are no page errors. This is a gap in the render setup, not a defect in the pull request: base and head ask for the same fonts.

| Typeface (font setup) | HUD: 2D Agents text and 3D deck rows | Result dialog: names and badges | Ended: deck rows / Agents text |
|---|---|---|---|
| Liberation Sans | drawn Liberation Sans, all 16 sets | drawn Liberation Sans, all 16 sets | drawn Liberation Sans, all 16 sets |
| Roboto (system-ui and sans-serif mapped) | drawn Roboto, all 16 sets | **drawn Liberation Sans, all 16 sets: no match** | drawn Roboto, all 16 sets |
| Roboto, Arial also mapped | drawn Roboto, all 16 sets | drawn Roboto, all 16 sets | drawn Roboto, all 16 sets |

The 16 sets in each row are the same in each typeface: two recordings (MEDIUM v HIGH, LOW v XHIGH) x board (2D, 3D) x build (5634b8e, b0616ba) x width (1280, 390). Each part's report names one font family and no fallback font.

- **Files:** `<typeface>/replay-fonts.json` holds one entry per capture set (typeface, font setup, recording, board, build and commit, width), and under each shot its screenshot file and SHA-256, `fontCheck` (intended family, drawn families, matched or not, each mismatched part), `fontParts` (each text part with its computed `font-family`, weight and drawn fonts) and the per-line fit. The Arial-mapped Roboto captures are in `roboto/replay-arial-as-roboto/` with their own `replay-fonts.json`.
- **Screenshots kept:** every Neon line crop captured again is byte-identical to the crop already on this branch, in both typefaces, at every shot. So each font report applies to the crops already here. 50 of the 72 full-page screenshots captured again are also byte-identical. The other 22 are HUD shots taken mid-playback: in each, the bytes differ while the Neon crops are identical. These 22 were replaced with the new captures, so each full-page file on the branch is the one its font report was taken from.
- **New shots:** ended shots (result dialog closed) for the 2D board on both recordings and for the 3D board on MEDIUM v HIGH. The earlier gap in the MEDIUM v HIGH 2D 1280 record is closed: `replay-fonts.json` holds its full per-line record.

## After merging main again: the Score Band HUD (new head 91e0e76)

The pull request branch took main by a second plain merge: **91e0e76d959d11c7a1f315a5c9cec43a70021742** (`91e0e76`) = 2e92b3e + main 8252f859b822457f34648283a60f9a0b0ee377c2 (`8252f85`, main #187). Main #187 replaces the replay HUD with one Score Band on both boards (`web/src/overlays.ts`: the 2D board now mounts the same deck HUD as the 3D board), and rewrites the deck agent rows. The 2D Agents list in the replay sections above is therefore no longer what merges, and neither are the 3D deck rows. This section compares **base 8252f85 (main) with head 91e0e76** on both boards. The replay HUD, result and ended states sections above stay as the record for b0616ba.

- **Captures:** both recordings (MEDIUM v HIGH, LOW v XHIGH), 2D and 3D board, HUD (about 20 s in), result dialog, and ended (dialog closed), at 1280 px and 390 px. Typefaces: Liberation Sans, and Roboto with Arial also mapped to Roboto (see Drawn fonts). Same browser, API snapshot and page clock as the replay sections; no request fell outside the snapshot. Captured 2026-11-19T17:40:22Z to 2026-11-19T18:40:00Z.
- **Files:** `<typeface>/score-band/replay-<match>-<board>/replay-<match>-<board>-<state>-<build>-<width>.png`, with a crop of every Neon line beside it. `<typeface>/score-band/score-band-fonts.json` has one entry per capture set (recording, board, build and commit, width, typeface and font setup). Each shot in it carries its file and SHA-256, every Neon line's fit, the drawn-font check, and every text part with its computed `font-family` and drawn fonts.
- **Drawn fonts:** all 16 capture sets in each typeface (2 recordings x 2 boards x 2 builds x 2 widths), at every shot, drew only the intended family: Liberation Sans, or Roboto. That covers the Score Band agent rows (name, level and RETIRED badges, rating, WINNER) and the result dialog's names and badges. Each part drew one family and no fallback.
- **Every state, width, typeface and board, base and head:** every Neon line is on one line and nothing is cut, there are no page errors, the result dialog opened and the ended shots closed it. At head the Score Band rows of LOW, MEDIUM and XHIGH carry RETIRED after the level; HIGH and every rating are unchanged.

Tightest fits at head (spare = (available − needed) / available; the 2D and 3D boards measure the same):

| Screen | Line | Typeface | Width | Needs / has px | Spare | Base, same line |
|---|---|---|---|---|---|---|
| Score Band row, result and ended | Gemini 4 Neon XHIGH RETIRED 1567 WINNER | Liberation Sans | 1280 | 298 / 313.9 | **5.1%** | 25.0% |
| same | same | Roboto | 1280 | 285.8 / 313.9 | 8.9% | 27.5% |
| same | same | Liberation Sans | 390 | 305 / 374 | 18.4% | 35.2% |
| Score Band row, during play | Gemini 4 Neon MEDIUM RETIRED 1433 | Liberation Sans | 1280 | 247.3 / 313.9 | 21.2% | 41.1% |
| same | same | Roboto | 1280 | 237.9 / 313.9 | 24.2% | 42.8% |
| Result dialog, Players | Gemini 4 Neon MEDIUM RETIRED | Liberation Sans | 390 | 253.3 / 326 | 22.3% | 46.9% |
| same | same | Roboto | 390 | 240.8 / 326 | 26.1% | 49.1% |

The WINNER row at 1280 px is now the tightest line in this evidence and the only one under 8%. It still fits on one line, uncut, in both typefaces. At 1280 px the Score Band's colony column is 313.9 px wide in every row, so this line has that width at every desktop width this capture used. Crop: `liberation-sans/score-band/replay-low-v-xhigh-3d/replay-low-v-xhigh-3d-ended-91e0e76-1280-neon-2.png`.

## Data and method

- **Builds:** `git archive` of each commit, built with `vite build --config web/vite.config.ts`.
- **Browser:** Playwright with chrome-headless-shell build 1254, every request routed offline. Viewports were 1280x800 and 390x844 (mobile, touch).
- **Replay method:** the same builds and browser; each replay loaded with `?replay=<id>&board=2d`, played about 20 s for the HUD, then seeked to the end through the replay slider until the result dialog opened. The 3D board is in its own section below.
- **Files:** each page is at `<typeface>/<page>/<page>-<build>-<width>.png`, with its Neon row crops beside it. Measurements are in `<typeface>/measurements.json`: per page, the Recordings and player-cell probes, the Neon rows, the padding and item checks, and the typeface the browser reported for each text part.
