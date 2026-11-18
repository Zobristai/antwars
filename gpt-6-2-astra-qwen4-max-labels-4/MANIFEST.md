# Renders: GPT-6.2 Astra and Qwen4 Max labels, retired qwen3-8-max, base vs head

Review renders for antwars PR #172. They are not part of the code and are not meant for main.

This set replaces `gpt-6-2-astra-qwen4-max-labels-3/` (PR comment 6968759869). That set had two defects, found in review:
- Its landing-page images never showed the recent-recordings row: it was below the first screen, and the expanded full-page image was blank below the original window.
- Its fit check reported "GPT-6.2 Astra" in the 390 Recordings cell in Liberation Sans as fitting with 0.8% to spare, while the page draws it as "GPT-6.2 As…". The old check compared whole-pixel box widths with a 1 px tolerance, so a 0.38 px overflow passed.

Both are fixed here (see Method). Nothing carries over from the earlier sets: every surface, width and typeface was rendered again.

## Commits
- Base: main `f04a72d3d4650fbf221c979c75974bda121d24f7`, the main commit merged into the head.
- Head: PR #172 at `3e78abe4851bbb3b5ee01d69190051782e6a85b9`.

Against this base the PR changes only its own nine files. Each build is `vite build --config web/vite.config.ts` of `git archive <commit>`: 202 files each, 42 of which differ between base and head. Digest of each build's sorted `sha256sum` listing: base `87789c881dc64189cbdd9a133324d02449f4773f52f5298ed3f1cf18edaec76e`, head `7f630d001be2f36aad93e70f7f2466039ee3a95f2484f10f1bd9e51be43a5373`.

## Snapshot
The public site's reads were each fetched once, without a key, and the same bytes were replayed to both builds, both widths and both typefaces. This is a new snapshot, taken for this set:

| # | Read | Fetched (UTC) | Status | Bytes | SHA-256 |
|---|---|---|---|---|---|
| 1 | `GET /watch/catalog` | 2026-11-18T04:42:45.916Z | 200 | 27 | `925a4ac44da87406997fd43d39760588cb13f7c2cc980069a34e00659dcbb2ac` |
| 2 | `POST /api/leaderboard {"limit":50,"mode":"house-1v1"}` | 2026-11-18T04:42:49.744Z | 200 | 43829 | `1bbcf0deab163fcdc70bc7a3da56890ea803e728bdf5520aec72bf835820a4e5` |
| 3 | `GET /matches` | 2026-11-18T04:42:51.051Z | 200 | 20061 | `da65d08a702ca2f449d25a5e94eec5e3cb712c08c4b6a637658d155892574cc6` |
| 4 | `GET /matches?pageToken=newest-v1%3A2026-11-13T14-02-58-594Z-160746063601453` | 2026-11-18T04:42:56.207Z | 200 | 20559 | `04da033879238172088ca5d0adc6311f33a10b420f7631e9f1c0278d015ec9f1` |
| 5 | `GET /matches?pageToken=newest-v1%3A2026-11-12T12-30-48-392Z-125466462052214` | 2026-11-18T04:43:37.963Z | 200 | 18488 | `4b560eda348c0e662399a55ac19ab9ad110227e17fccc0e9d30e73d03603e95b` |
| 6 | `GET /watch/queue` | 2026-11-18T04:45:13.370Z | 200 | 27 | `69c85289c8c00786ed87528a0c9ad434e398648dffc8b0262fa53fccb904e6fd` |
| 7 | `GET /watch/ratings/2026-11-12T09-58-04-540Z-134589846669134` | 2026-11-18T04:47:13.172Z | 200 | 303 | `1295f35538167ca6fbc47a138be18cf7ab96ec1097114a9448dfcd1f629213a4` |
| 8 | `GET /replays/2026-11-12T09-58-04-540Z-134589846669134` | 2026-11-18T04:47:14.978Z | 200 | 33674202 | `04852bb6111c170b3179b51e4dba797516cc340adbfe98aebbc9977c96f3d5c6` |
| 9 | `GET /matches/2026-11-12T09-58-04-540Z-134589846669134` | 2026-11-18T04:47:17.056Z | 200 | 2694984 | `c1f33ae0a1de0538a7addf069cbd47e63f4125c04d1d99d6461a922a75047111` |
| 10 | `GET /matches/2026-11-18T02-00-00-000Z-100000000000001` | 2026-11-18T04:50:00.725Z | 404 | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

Read 8 is the stored recording of a real index match, claude-haiku-5-5 vs qwen3-8-max (33.7 MB, the same bytes as in the earlier sets). It is not committed here; its URL is immutable, so it can be fetched again and checked against the digest. Read 10 is the match-detail read for the fixture recording's id, which the public site answers with 404. Every other read's bytes are in `api/snapshot/`. With more matches played since the earlier set, qwen3-8-max's real Recordings row is now on the third history page (read 5).

## Fixture data
None of the eight new handles has played yet, so no real row can show them. Every fixture row is listed here; every other row is real.
- **Leaderboard (house 1v1):** eight rows, one per new handle, one rated match each, inserted in rating order. low, high and max of GPT-6.2 Astra and Qwen4 Max high are at 1516 (1–0); medium and xhigh of GPT-6.2 Astra and Qwen4 Max low and xhigh are at 1484 (0–1). RD 330, no stored replay. Each row's level and tier are what that build's server reports for an unplayed listed handle: none on base, which has no label row for them; on head, the label row's level, and Fast for the five GPT-6.2 Astra rows.
- **Matches, Waiting:** two house 1v1 lobbies, gpt-6-2-astra-low vs qwen4-max-high and gpt-6-2-astra-high vs gpt-6-2-astra-xhigh.
- **Matches, Live now:** two index 1v1 matches, gpt-6-2-astra-medium vs qwen4-max-xhigh and gpt-6-2-astra-max vs qwen4-max-low, at the leaderboard fixture ratings.
- **Recordings (Matches and landing):** one row for the fixture recording below, gpt-6-2-astra-medium vs qwen4-max-xhigh, dated 2026-11-18 02:00 UTC. Every other field is copied from the real qwen3-8-max match's row.
- **Fixture recording (HUD):** the real recording of read 8, decoded with the head's own stream code, with its two seats' handle, model label, level and tier replaced by gpt-6-2-astra-medium (openai/gpt-6.2-astra, medium, fast) and qwen4-max-xhigh (qwen-token-plan/qwen4-max, xhigh), and encoded again (`tools/make-fixture-recording.ts`, run from `3e78abe4`'s tree). Re-encoding all 9136 unchanged messages first gave back the stored bytes exactly. Play, board and every other field are the real match's. Its ratings read is the real match's with the two names replaced. SHA-256 `aad1226c7419cc3fa265df3fc3a0b37cf73d00cebb51da6fe07f43c9c0b9e844`, 33674209 bytes, identical to the earlier sets' fixture.

Real rows: qwen3-8-max's leaderboard row, its Recordings row (third history page, reached with the page's own Load more button) and its replay's HUD.

## Method
- Browser: Chrome for Testing headless shell 158.0.8127.18, 1280×800, and 390×844 as a phone (mobile, touch), device scale 1.
- Typefaces, each installed and mapped to `system-ui` and `sans-serif` for its set (`tools/fonts-<typeface>.conf`, which reads the font files from a `fonts/` folder beside `tools/`). The site serves no web font for UI text.
  - Roboto (font version 197657): Regular `9f300202f482ad59f8b13bc3131a295744d14fd530fa3765a0a11ec87264d203`, Medium `80ce163ec5ecd91a883aa20e80d31dc74971b55cf658dd7c5e8d21f4e9fcb417`, Bold `44f13e570a8b3fc42240abfcb3d72fe298f3dd6a25db0c78d0c2495dbd0e9121`.
  - Liberation Sans (font version 137625): Regular `4659bc0c58c5028dd488ec928d41d9265db43d9b669fc14ca8b0832daca7b144`, Bold `3973aa5054fb467dd5627245d3dc82e37bf16fe075756156a570455871351582`.
- **Font actually drawn**, from the browser's own font report (`CSS.getPlatformFontsForNode`). Probed on every image: every changed label in view, every badge beside it, and the first visible heading, column heading, button and body-text leaf. 376 probes per typeface; every one reports an installed font of its set and no fallback (Roboto-Bold and Roboto-Regular; LiberationSans-Bold and LiberationSans).
- **Every image is the browser window as a person sees it after scrolling** to the part shown. There are no whole-page images and nothing on the page is resized.
- Surfaces, at base and head, both widths, both typefaces:
  - **Leaderboard** (house 1v1): `01` centred on the first fixture row, `02` on the last, `03` on qwen3-8-max's row.
  - **Matches**: `01` top (Waiting and Live now), `02` scrolled to the fixture Recordings row, `03` qwen3-8-max's Recordings row after Load more.
  - **Landing**: `01` top, `02` scrolled to the recent-recordings card with the fixture recording's row centred, `03` the ranking card.
  - **HUD, retired**: the real qwen3-8-max replay. **HUD, fixture**: the fixture recording. Both opened with the 2D board and moved to 3:00 with the replay slider; each image's replay time is in the report (3:03 to 3:07, since playback runs on). At 1280, `01` the whole screen, agents list included. At 390, `01` the top screen, then `02` and `03` with the agents pane scrolled to each agent.
- **Fit check, measured on what is drawn** (`tools/items-check.mjs`): for every visible heading, column heading, button, chip, badge and one-line item, each text run's laid-out glyph boxes (fractional pixels, nothing rounded) are compared with the edge of every ancestor, the item included, that hides overflow: its content box where `text-overflow: ellipsis` applies, its padding box otherwise. A run past an edge by more than 0.05 px makes the item **clipped**, reported with the amount and the element that cuts it. A clipped or wrapped item is a failure and has no spare width. For the rest, spare width is measured by widening an invisible spacer at the end of the item's text until anything changes, and the spacer counts as drawn content in the same clip test, so an ellipsis that would hide it ends the search. Each changed label and badge is checked the same way, and wrapping, overlap and horizontal overflow are checked per image. `tools/summarize.py` prints the comparison below.

## Result
- **"GPT-6.2 Astra" in the 390 Recordings cell, Liberation Sans, truncates by the site's design.** The name needs 75.4 px of a 75 px cell. It is drawn 0.38 px past the cell's edge, so the cell shows "GPT-6.2 As…" on Matches and on the landing page. A player's name in that cell is ellipsised by design (`.d1p-rec-name` in `web/src/pages/archive.css` sets `overflow: hidden; text-overflow: ellipsis`), and longer existing names in the same cell already truncate at base: in this snapshot "Claude Fable 5.2" shows as "Claude Fab…", "Gemini 4 Hydrogen" as "Gemini 4 H…" and "antwars-flow-test" as "antwars-flo…" (`matches-head-390-02-fixture-recording.png`, Liberation Sans). Base's own label for the same fixture row, "Unlisted model", is cut by 4.4 px. In Roboto, "GPT-6.2 Astra" fits, with 2.7% to spare. The PR does not change this.
- **Head** shows "GPT-6.2 Astra" with its level badge and FAST, and "Qwen4 Max" with its level badge, wherever these handles appear: Leaderboard, Waiting, Live now, Recordings (Matches and landing) and the HUD's agents list ("GPT-6.2 Astra (medium · Fast)", "Qwen4 Max (xhigh)"). **Base** shows "Unlisted model" with no badge in the same places.
- **qwen3-8-max** keeps its name, rating (1327, rank 43 in these renders, fixture rows included) and record (7–13) on the Leaderboard. Head adds a RETIRED badge there, "xhigh retired" on its Recordings row, and "(xhigh · retired)" in the HUD's agents list; base shows the same rows without it.
- Every changed badge is on one line and unclipped everywhere. Every changed label is on one line and unclipped except "GPT-6.2 Astra" in the 390 Liberation Sans Recordings cell, above. No horizontal overflow and no overlap anywhere. Apart from that cell, no item wraps or is clipped at head that does not at base.
- Wrapped or clipped items present identically in base and head, in parts this change does not touch:
  - Landing at 1280, both typefaces: the ranking card's "RATED MATCHES" column heading wraps to two lines.
  - Matches and landing, both widths and typefaces: in the Recordings list, names and level badges longer than their cell are ellipsised (at 1280, "GPT-6.1 Terra" and "max fast" in one row; at 390, many more).
- The FAST badge on each GPT-6.2 Astra row is the existing tier badge, as on GPT-6.1 Sol rows.

### Every item with less than 8% spare width
| Page | Width | Typeface | Item | Spare | Needed / available (px) | Base | Head |
|---|---|---|---|---|---|---|---|
| Landing | 1280 | Roboto | one-line "GPT-6.1 Sol" | 7.2% | 61.4 / 66.2 | yes | yes |
| Landing | 1280 | Roboto | one-line "Muse Wonder" | 7.6% | 73.8 / 79.8 | yes | yes |
| Landing | 390 | Roboto | one-line "GPT-6.2 Astra" | 2.7% | 72.8 / 74.8 | no | yes |
| Matches | 1280 | Roboto | one-line "GPT-6.1 Sol" | 7.2% | 61.4 / 66.2 | yes | yes |
| Matches | 1280 | Roboto | one-line "Muse Wonder" | 7.6% | 73.8 / 79.8 | yes | yes |
| Matches | 390 | Roboto | one-line "GPT-6.1 Terra" | 4.5% | 71.6 / 75 | yes | yes |
| Matches | 390 | Roboto | one-line "GPT-6.2 Astra" | 2.7% | 72.8 / 74.8 | no | yes |
| Matches | 390 | Roboto | one-line "Qwen3.8 Max" | 2.7% | 72.9 / 74.9 | yes | yes |
| Landing | 1280 | Liberation Sans | one-line "GPT-6.1 Sol" | 0.8% | 65.4 / 65.9 | yes | yes |
| Landing | 1280 | Liberation Sans | one-line "Muse Wonder" | 3.8% | 74.5 / 77.4 | yes | yes |
| Landing | 1280 | Liberation Sans | one-line "high fast" | 1.5% | 45.4 / 46.1 | yes | yes |
| Landing | 390 | Liberation Sans | button "NEW: Your agent can challenge the top models" | 2.8% | 312.7 / 321.9 | yes | yes |
| Leaderboard | 390 | Liberation Sans | button "NEW: Your agent can challenge the top models" | 2.8% | 312.7 / 321.9 | yes | yes |
| Matches | 1280 | Liberation Sans | one-line "GPT-6.1 Sol" | 0.8% | 65.4 / 65.9 | yes | yes |
| Matches | 1280 | Liberation Sans | one-line "Muse Wonder" | 3.8% | 74.5 / 77.4 | yes | yes |
| Matches | 1280 | Liberation Sans | one-line "Muse Wonder Full 1.0" | 7.2% | 117.2 / 126.3 | yes | yes |
| Matches | 1280 | Liberation Sans | one-line "high fast" | 1.5% | 45.4 / 46.1 | yes | yes |
| Matches | 390 | Liberation Sans | one-line "Qwen3.8 Max" | 1.2% | 74 / 74.9 | yes | yes |
| Matches | 390 | Liberation Sans | one-line "max" | 3% | 22.7 / 23.4 | yes | yes |
| Matches | 390 | Liberation Sans | one-line "×2" | 3% | 13.7 / 14.1 | yes | yes |

"GPT-6.2 Astra" in Liberation Sans at 390 is not in this table because it is clipped, not tight. The leaderboard has none from this change in either typeface.

## Files
`pages/<roboto|liberation-sans>/<surface>-<base|head>-<width>-<shot>.png` (52 per typeface), the two JSON reports, the replayed reads and the fixture reads as served under `api/`, and the capture tools under `tools/`. `SHA256SUMS` covers every file here.
