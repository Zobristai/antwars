# Renders: Gemini 4 Hydrogen labels, base vs head

Review renders for antwars PR #103. They are not part of the code and are not meant for main.

## Commits
- Base: main `62e84f925048010240a5fded62464550c572fe89`.
- Head: PR #103 at `2294b50f26851e533a42f01e7a36d0543bafd794`.

## Snapshot
The public site's reads were each fetched once, without a key, and the same bytes were replayed to both builds, both widths and both typefaces:

| Read | Fetched (UTC) | Bytes | SHA-256 |
|---|---|---|---|
| `POST /api/leaderboard {"limit":50,"mode":"house-1v1"}` | 2026-11-13T02:25:29.523Z | 40680 | `8b12e46274e1e0d7e003b04f8ac579d9444fa16c4255e0e152be65b3085d4fac` |
| `GET /watch/catalog` | 2026-11-13T02:32:55.015Z | 1019 | `fd71c1df7bf6d5afa31b5a55fb5a1ad871eaeb0e0fce29c2927f4c28d18cd215` |
| `GET /matches` | 2026-11-13T02:32:55.112Z | 20272 | `76580f13868785465b3219a85d0db467f6cb3a22a53703b0ac2a733052442441` |
| `GET /watch/queue` | 2026-11-13T02:33:20.167Z | 157 | `0248d88e61d446fd3ba771d8c0cd5984c779d403364713b7a1b40fa7d8816150` |

## Fixture data
The four handles have no matches yet, so no real row can show them. Every other row is real.
- **Leaderboard (house 1v1):** four fixture rows, inserted in rating order. `gemini-4-hydrogen-low` and `-high` are at 1516 (1 rated match, 1–0). `-medium` and `-xhigh` are at 1484 (0–1). RD is 330 and no replay is stored. Each row's level is what that build's server reports for an unplayed listed handle: none on base, which has no label row, and the label's level on head.
- **Matches:** one seeded Waiting lobby, house 1v1, medium vs high. One seeded Live now match, Index · 1v1, xhigh vs low, at the same ratings.
- **Not rendered, with the reason:** there is no recording of these handles, so Recordings and the Watch page cannot show them. The landing page's ranking card lists only the top ten, which the fixture rows (rank 20 and 26) do not reach; it is rendered to show it unchanged. The challenge opponent list has no page; it is an API listing and is covered by tests.

## Method
- Builds: `vite build --config web/vite.config.ts` of `git archive <commit>` for each commit, served locally.
- Browser: Chrome for Testing headless shell (Playwright build 1254), 1280×800 and 390×844 (mobile, touch), device scale 1.
- Typefaces: Roboto v3.016 (hinted static Regular, Medium, Bold) and Liberation Sans, each installed and mapped to `system-ui` and `sans-serif` for its set. The site serves no web font for UI text.
- Font actually drawn: Chromium's `CSS.getPlatformFontsForNode` (the font the browser rendered the glyphs with, not the CSS `font-family`) on every fixture label, every level badge beside it, and the first visible heading, column heading, button and body-text leaf of each page. Every probe in every capture reports an installed font of its set's typeface and no fallback:
  - Roboto set: Roboto-Bold and Roboto-Regular only (90 probes).
  - Liberation Sans set: LiberationSans-Bold and LiberationSans only (90 probes).
  Each report entry's `platformFonts` lists each probe with the font's PostScript name and glyph count.
- Pages, at base and head, both widths, both typefaces:
  - Leaderboard (house 1v1): `01` one screen centred on the first fixture row (LOW and HIGH), `02` one centred on the last (MEDIUM and XHIGH), and `full`, the whole page.
  - Matches: `01` top (Waiting), `02` Live now, `full`.
  - Landing: `01` top, `02` ranking card, `full`.
- Full-page images: the site scrolls inside its own fixed container, so for the `full` image only, taken after every measurement, each scrolling container is let grow to its content height in the page flow. That is the only change made to the page. All measurements come from the unchanged page.
- Checks (`render-report-<typeface>.json`): each Hydrogen label (head) or "Unlisted model" (base) and its level badge, checked for lines and clipping. Every visible heading, button, chip, badge and one-line item is checked for wrapping, clipping and overlap, and its spare width is measured (`items`, with `spare` in percent). Horizontal overflow is checked per page.

## Result
- Head shows "Gemini 4 Hydrogen" with its level badge (LOW, MEDIUM, HIGH, XHIGH) on every fixture row of the Leaderboard and Matches, at both widths in both typefaces. Name and badge are each on one line, unclipped, with no overlap.
- Base shows "Unlisted model" with no badge in the same places.
- No horizontal overflow and no overlap anywhere.
- Wrapped or clipped items, identical in base and head, in a part this change does not touch: the landing ranking card's "RATED MATCHES" column heading wraps to two lines at 1280 in both typefaces.

### Every item with less than 8% spare width
| Page | Width | Typeface | Item | Spare | Base | Head |
|---|---|---|---|---|---|---|
| Leaderboard | 390 | Liberation Sans | button "NEW: Your agent can challenge the top models" | 2.8% | yes | yes |
| Landing | 390 | Liberation Sans | button "NEW: Your agent can challenge the top models" | 2.8% | yes | yes |

There are none in the Roboto set, and none among the Hydrogen labels and badges in either set. Both entries are the same site-wide button, outside this change, and identical in base and head.

## Files
`pages/<roboto|liberation-sans>/<page>-<base|head>-<width>-<01|02|full>.png` (36 per typeface), the two JSON reports, the replayed reads under `api/`, and the capture tools under `tools/`.
