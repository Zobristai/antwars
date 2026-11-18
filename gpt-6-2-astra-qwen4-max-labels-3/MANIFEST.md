# Renders: GPT-6.2 Astra and Qwen4 Max labels, retired qwen3-8-max, base vs head

Review renders for antwars PR #172, made against its current head and checked against the site's UI review bar. They are not part of the code and are not meant for main. This set replaces the set in `gpt-6-2-astra-qwen4-max-labels-2/`, made at head `6166991f` against main `8880c21a`. None of those renders carries over: PR #172 has since been updated from main, which brought in #168 and #171, and #168 changes shared web modules (the data source and stream code), so every surface, width and typeface was rendered again from the new builds.

## Commits
- Base: main `cfe6bccb3ec8648273845a057d837b15f7fe9b07` (the main commit merged into the head).
- Head: PR #172 at `8546f0e1cc1756ddb932289be09463cb57913f50`.

Against this base the PR still changes only its own nine files. Each build's source tree was checked file for file against `git archive` of its commit.

The change is server-side data only (the house label table and the retired set). Both are also bundled into the site, so each build is the site built from that commit.

## Snapshot
The public site's reads were each fetched once, without a key, and the same bytes were replayed to both builds, both widths and both typefaces. This is the same snapshot, byte for byte, as the earlier set, so the two sets differ only in the builds:

| # | Read | Fetched (UTC) | Status | Bytes | SHA-256 |
|---|---|---|---|---|---|
| 1 | `POST /api/leaderboard {"limit":50,"mode":"house-1v1"}` | 2026-11-18T03:06:15.791Z | 200 | 43829 | `1bbcf0deab163fcdc70bc7a3da56890ea803e728bdf5520aec72bf835820a4e5` |
| 2 | `GET /matches` | 2026-11-18T03:07:06.954Z | 200 | 20442 | `24d9c558450878492f794f6da6f83879cad3468d93955d8d52837bd2ff69cca8` |
| 3 | `GET /watch/queue` | 2026-11-18T03:07:06.971Z | 200 | 27 | `69c85289c8c00786ed87528a0c9ad434e398648dffc8b0262fa53fccb904e6fd` |
| 4 | `GET /matches?pageToken=newest-v1%3A2026-11-13T12-39-51-207Z-44146181134910` | 2026-11-18T03:07:07.029Z | 200 | 21245 | `cb912dd208b1743559b88fc1ef86df38cf8496e96f77d59e1199dc33d8b0a93c` |
| 5 | `GET /watch/catalog` | 2026-11-18T03:07:07.184Z | 200 | 531 | `1e6f60d44ccba8b87f4a2542542e7918c54f126fa1f53cf31c3d35b3bca002d7` |
| 6 | `GET /watch/ratings/2026-11-12T09-58-04-540Z-134589846669134` | 2026-11-18T03:08:49.156Z | 200 | 303 | `1295f35538167ca6fbc47a138be18cf7ab96ec1097114a9448dfcd1f629213a4` |
| 7 | `GET /replays/2026-11-12T09-58-04-540Z-134589846669134` | 2026-11-18T03:08:50.795Z | 200 | 33674202 | `04852bb6111c170b3179b51e4dba797516cc340adbfe98aebbc9977c96f3d5c6` |
| 8 | `GET /matches/2026-11-12T09-58-04-540Z-134589846669134` | 2026-11-18T03:08:52.959Z | 200 | 2694984 | `c1f33ae0a1de0538a7addf069cbd47e63f4125c04d1d99d6461a922a75047111` |
| 9 | `GET /matches/2026-11-18T02-00-00-000Z-100000000000001` | 2026-11-18T03:11:13.648Z | 404 | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

Read 7 is the stored recording of a real index match, claude-haiku-5-5 vs qwen3-8-max (33.7 MB). It is not committed here. Its URL is immutable, so the same bytes can be fetched again and checked against the digest. Read 9 is the match-detail read for the fixture recording's id; the public site has no such match and answers 404, which the fixture replay was given unchanged. Every other read's bytes are in `api/snapshot/`.

## Fixture data
None of the eight new handles has played yet, so no real row can show them. Every fixture row is listed here; every other row is real.
- **Leaderboard (house 1v1):** eight rows, one per new handle, one rated match each, inserted in rating order. low, high and max of GPT-6.2 Astra and Qwen4 Max high are at 1516 (1–0); medium and xhigh of GPT-6.2 Astra and Qwen4 Max low and xhigh are at 1484 (0–1). RD 330, no stored replay. Each row's level and tier are what that build's server reports for an unplayed listed handle: none on base, which has no label row for them; on head, the label row's level, and Fast for the five GPT-6.2 Astra rows.
- **Matches, Waiting:** two house 1v1 lobbies, gpt-6-2-astra-low vs qwen4-max-high and gpt-6-2-astra-high vs gpt-6-2-astra-xhigh.
- **Matches, Live now:** two index 1v1 matches, gpt-6-2-astra-medium vs qwen4-max-xhigh and gpt-6-2-astra-max vs qwen4-max-low, at the leaderboard fixture ratings.
- **Recordings (Matches and landing):** one row, newest, for the fixture recording below: gpt-6-2-astra-medium vs qwen4-max-xhigh. Every other field is copied from the real qwen3-8-max match's row.
- **Fixture recording (HUD):** the real recording of read 7, decoded with the head's own stream code (made again from `8546f0e1`'s code for this set), with its two seats' handle, model label, level and tier replaced by gpt-6-2-astra-medium (openai/gpt-6.2-astra, medium, fast) and qwen4-max-xhigh (qwen-token-plan/qwen4-max, xhigh), and encoded again (`tools/make-fixture-recording.ts`). Before the change, re-encoding all 9136 messages with `8546f0e1`'s code gave back the stored bytes exactly, and the result is byte-identical to the earlier set's fixture. Play, board and every other field are the real match's. Its ratings read is the real match's with the two names replaced. SHA-256 `aad1226c7419cc3fa265df3fc3a0b37cf73d00cebb51da6fe07f43c9c0b9e844`, 33674209 bytes.

Real rows: qwen3-8-max's leaderboard row, its Recordings row (on the second history page, reached with the page's own Load more button) and its replay's HUD.

## Method
- Builds: `vite build --config web/vite.config.ts` of `git archive <commit>` for each commit, served locally.
- Browser: Chrome for Testing headless shell 158.0.8127.18, 1280×800, and 390×844 as a phone (mobile, touch), device scale 1.
- Typefaces, each installed and mapped to `system-ui` and `sans-serif` for its set (`tools/fonts-<typeface>.conf`). The site serves no web font for UI text.
  - Roboto (font version 197657): Regular `9f300202f482ad59f8b13bc3131a295744d14fd530fa3765a0a11ec87264d203`, Medium `80ce163ec5ecd91a883aa20e80d31dc74971b55cf658dd7c5e8d21f4e9fcb417`, Bold `44f13e570a8b3fc42240abfcb3d72fe298f3dd6a25db0c78d0c2495dbd0e9121`.
  - Liberation Sans (font version 137625): Regular `4659bc0c58c5028dd488ec928d41d9265db43d9b669fc14ca8b0832daca7b144`, Bold `3973aa5054fb467dd5627245d3dc82e37bf16fe075756156a570455871351582`.
- **Font actually drawn**, from the browser's own font report (`CSS.getPlatformFontsForNode`, the font the glyphs were drawn with, not the CSS `font-family`). Probed on every screenshot: every changed label in view (a model name or the HUD's model line), every badge beside it, and the first visible heading, column heading, button and body-text leaf. 353 probes per typeface. Every probe reports an installed font of its set and no fallback:
  - Roboto set: Roboto-Bold and Roboto-Regular only.
  - Liberation Sans set: LiberationSans-Bold and LiberationSans only.
  Each report entry's `platformFonts` lists each probe with the font's PostScript name and glyph count.
- Surfaces, at base and head, both widths, both typefaces:
  - **Leaderboard** (house 1v1): `01` one screen centred on the first fixture row, `02` on the last, `03` on qwen3-8-max's row, and `full`.
  - **Matches**: `01` top (Waiting and Live now), `02` the fixture Recordings row, `03` qwen3-8-max's Recordings row after Load more, and `full`.
  - **Landing**: `01` top (its recent recordings include the fixture row), `02` the ranking card (its top ten, which no fixture row reaches), and `full`.
  - **HUD, retired**: the real qwen3-8-max replay. **HUD, fixture**: the fixture recording. Both opened with the 2D board and moved to 3:00 with the replay slider; each image's replay time is in the report (3:04 to 3:11, since playback runs on). At 1280, `01` the whole screen, agents list included. At 390, `01` the top screen, then `02` and `03` with the agents pane (a short pane under the board that scrolls on its own) scrolled to each agent.
- Full-page images: the site scrolls inside its own containers, so for the `full` image only, taken after every measurement, each scrolling container is let grow to its content height. That is the only change made to the page. All measurements come from the unchanged page.
- Checks (`render-report-<typeface>.json`, `tools/items-check.mjs`): every visible heading, column heading, button, chip, badge and one-line item is checked for wrapping, clipping and overlap, and its spare width is measured (`items`, with `spare` in percent); each changed label and badge is checked for lines and clipping; horizontal overflow is checked per screenshot. `tools/summarize.py` prints the comparison below.

## Result
The findings below are the same as the earlier set's, measured again: the same items fail, wrap or are tight, with the same spare widths.

- **Head** shows "GPT-6.2 Astra" with its level badge and FAST, and "Qwen4 Max" with its level badge, wherever these handles appear: Leaderboard, Waiting, Live now, Recordings (Matches and landing) and the HUD's agents list ("GPT-6.2 Astra (medium · Fast)", "Qwen4 Max (xhigh)"). **Base** shows "Unlisted model" with no badge in the same places.
- **qwen3-8-max** keeps its name, rating (1327, rank 43 in this snapshot) and record on the Leaderboard. Head adds a RETIRED badge there, "xhigh retired" on its Recordings row, and "(xhigh · retired)" in the HUD's agents list; base shows the same rows without it.
- Every changed label and badge is on one line and unclipped in both typefaces at both widths. No horizontal overflow and no overlap anywhere. No item wraps or is clipped at head that does not at base.
- Wrapped or clipped items present identically in base and head, in parts this change does not touch:
  - Landing at 1280, both typefaces: the ranking card's "RATED MATCHES" column heading wraps to two lines.
  - Matches and landing at 390, both typefaces: in the Recordings list each colony cell is narrow, and a model or player name longer than the cell is ellipsised (for example "Claude Haiku 5.5", "Gemini 4 Hydrogen", "GPT-6.1 Terra" where a rating sits beside it). On base the fixture row's "Unlisted model" is ellipsised this way too; on head "GPT-6.2 Astra" and "Qwen4 Max" fit.
- Nothing in these renders is denser or repeats text on every row more than base does. The FAST badge on each GPT-6.2 Astra row is the existing tier badge, as on GPT-6.1 Sol rows.

### Every item with less than 8% spare width
| Page | Width | Typeface | Item | Spare | Needed / available (px) | Base | Head |
|---|---|---|---|---|---|---|---|
| Landing | 390 | Liberation Sans | one-line "GPT-6.2 Astra" | 0.8% | 75.4 / 76 | no | yes |
| Landing | 390 | Liberation Sans | button "NEW: Your agent can challenge the top models" | 2.8% | 312.7 / 321.9 | yes | yes |
| Landing | 390 | Roboto | one-line "GPT-6.2 Astra" | 4.1% | 72.8 / 75.9 | no | yes |
| Leaderboard | 390 | Liberation Sans | button "NEW: Your agent can challenge the top models" | 2.8% | 312.7 / 321.9 | yes | yes |
| Matches | 1280 | Liberation Sans | one-line "Muse Wonder Full 1.0" | 7.9% | 117.2 / 127.2 | yes | yes |
| Matches | 390 | Liberation Sans | one-line "GPT-6.1 Terra" | 0.8% | 75.1 / 75.7 | yes | yes |
| Matches | 390 | Liberation Sans | one-line "GPT-6.2 Astra" | 0.8% | 75.4 / 76 | no | yes |
| Matches | 390 | Liberation Sans | one-line "Qwen3.8 Max" | 2.3% | 74 / 75.8 | yes | yes |
| Matches | 390 | Liberation Sans | one-line "max" | 3% | 22.7 / 23.4 | yes | yes |
| Matches | 390 | Liberation Sans | one-line "×2" | 3% | 13.7 / 14.1 | yes | yes |
| Matches | 390 | Roboto | one-line "GPT-6.1 Terra" | 5.5% | 71.6 / 75.8 | yes | yes |
| Matches | 390 | Roboto | one-line "GPT-6.2 Astra" | 4.1% | 72.8 / 75.9 | no | yes |
| Matches | 390 | Roboto | one-line "Qwen3.8 Max" | 4.1% | 72.9 / 76 | yes | yes |

The three rows marked "no" under Base are the new "GPT-6.2 Astra" name in the 390 Recordings cell (Matches and the landing page's recent recordings). It fits, with 0.8% to spare in Liberation Sans and 4.1% in Roboto. In a row where a rating sits beside it, the cell is narrower and the name would be ellipsised like the existing names above. The leaderboard has none from this change in either typeface.

## Files
`pages/<roboto|liberation-sans>/<surface>-<base|head>-<width>-<shot>.png` (60 per typeface), the two JSON reports, the replayed reads and the fixture reads as served under `api/`, and the capture tools under `tools/`. `SHA256SUMS` covers every file here.
