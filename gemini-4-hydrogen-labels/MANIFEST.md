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
- Typefaces: Roboto v3.016 (hinted static Regular, Medium, Bold) and Liberation Sans, each mapped to `system-ui` and `sans-serif`. Chromium's `CSS.getPlatformFontsForNode` on the label and badge reports Roboto-Regular/Roboto-Bold and LiberationSans/LiberationSans-Bold respectively (`platformFonts` in each report).
- Pages: Leaderboard (house 1v1), scrolled to the first fixture row; landing, top and ranking card; Matches, top (Waiting) and Live now.
- Checks (`render-report-<typeface>.json`): each Hydrogen label (head) or "Unlisted model" (base) and its level badge, checked for lines and clipping; every visible heading, button, chip, badge and one-line item checked for wrapping, clipping and overlap, with spare width measured; page horizontal overflow.

## Result
- Head shows "Gemini 4 Hydrogen" with its level badge (LOW, MEDIUM, HIGH, XHIGH) on every fixture row of the Leaderboard and Matches, at both widths in both typefaces. Name and badge are each on one line, unclipped, with no overlap.
- Base shows "Unlisted model" with no badge in the same places.
- No horizontal overflow anywhere.
- Items flagged identically in base and head, in parts this change does not touch:
  - landing at 1280, both typefaces: the "RATED MATCHES" column heading wraps to two lines;
  - Leaderboard and landing at 390, Liberation Sans: the "NEW: Your agent can challenge the top models" button has 2.8% spare width.

## Files
`pages/<roboto|liberation-sans>/<page>-<base|head>-<width>-<NN>.png`, and the two JSON reports.
