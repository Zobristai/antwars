# Render evidence: four Gemini 4 Neon house handles

- **Base:** 423f6bc6375eae4d485f7f386913ef3eebc90e09 (main, `423f6bc` in file names).
- **Head:** c1722d5df2f47ededd81e347f9856db828c4d3d3 (`c1722d5`), the pull request's head after merging main.
- **Pages:** Matches, Leaderboard and the landing page, at 1280 px and 390 px, in Roboto and Liberation Sans, on real data and on real data plus fixture rows for the new handles (which do not exist live yet).
- Evidence only: it states what was rendered and measured. The earlier set (base `10bba61`, head `7997aaf`) is in this branch's history.

## Fixture rows

The fixture set (`<typeface>/<page>-fixture/`) is the real snapshot plus these fixture rows, named here as fixtures; nothing else in it differs from the real set:

- Leaderboard: four fixture entries, `antwars/gemini-4-neon-xhigh` (1662, 1–0), `antwars/gemini-4-neon-high` (1662, 1–0), `antwars/gemini-4-neon-medium` (1338, 0–1) and `antwars/gemini-4-neon-low` (1338, 0–1), each with one rated match. They land at ranks 15, 16, 41 and 45.
- Recordings: two fixture index 1v1 recordings, xhigh against low and high against medium, both started at 1500.

## Gemini 4 Neon fits

On head, every fixture row reads **Gemini 4 Neon** with its level, as its own entry, on one line and uncut, at both widths in both typefaces. **No Gemini 4 Neon fit is under 8% spare.** The tightest measured fits:

| Where | Roboto 1280 | Roboto 390 | Liberation Sans 1280 | Liberation Sans 390 |
|---|---|---|---|---|
| Recordings player line, tightest ("Gemini 4 Neon MEDIUM 1500"), Matches and landing | 167.1 of 233 px, 28.3% | 167.1 of 247 px, 32.3% | 168.8 of 233 px, 27.5% | 168.8 of 247 px, 31.7% |
| Match card model name "Gemini 4 Neon", Matches and landing, tightest | 46.0% | ≥ 50% | 44.7% | 49.7% |
| Leaderboard name cell, tightest ("Gemini 4 Neon MEDIUM") | 48.6% | one line, uncut; spare not measured | 46.4% | one line, uncut; spare not measured |

The 390 px Leaderboard renders each entry as a card whose name is not a one-line item, so only its line count and clipping are measured there. Crops: `<typeface>/<page>-fixture/<page>-c1722d5-<width>-neon-<n>.png`.

On base the label does not exist: no "Gemini 4 Neon" text appears in any base render, and the four fixture Recordings player lines read "Unlisted model".

## Two lines and cut text

On every page, width, typeface and data set, base and head:

- no Matches or landing player line takes two lines, no name is cut, no badge group is clipped and no badge breaks;
- every colony cell keeps its inner padding, no column head leaves its cell, no item overlaps another, and there is no page error.

Real-data and fixture pages are the same height at base and head. Lines under 8% spare, or wrapped, are all existing rows, identical at base and head:

- Recordings lines: Roboto 1280, "GPT-6.2 Astra MEDIUM Fast retired 1500" 5.0% and "CedarGrove GPT-6.1 Terra MAX Fast 1500" 7.2%. Liberation Sans 1280, "GPT-6.2 Astra MEDIUM Fast retired 1500" 2.1%, "CedarGrove GPT-6.1 Terra MAX Fast 1500" 3.5%, three "GPT-6.2 Astra XHIGH Fast retired" lines 6.0% and "CedarGrove Muse Wonder MAX 1500" 6.9%. Liberation Sans 390, "GPT-6.2 Astra MEDIUM Fast retired 1500" 7.6%.
- Other items: Liberation Sans, "GPT-6.2 Astra" model name on Matches at 1280, 6.2%; the "NEW: Your agent can challenge the top models" banner on Leaderboard and landing at 390, 2.8%. The landing page's "RATED MATCHES" heading takes two lines at 1280 in both typefaces.

## Data and method

- **Real snapshot:** the public antwars.ai API's answers (leaderboard, matches, watch catalog and queue) recorded 2026-11-19T03:23:27Z to 2026-11-19T03:23:44Z, the same snapshot as the earlier set, replayed offline for every build; page clock pinned at 2026-11-19T03:30:00Z.
- **Builds:** `git archive` of each commit, built with `vite build --config web/vite.config.ts`.
- **Browser:** Playwright with chrome-headless-shell build 1254, every request routed offline. Viewports 1280x800 and 390x844 (mobile, touch).
- **Files:** `<typeface>/<page>[-fixture]/<page>-<build>-<width>.png` (viewport), `-full.png` (whole page), crops beside them; measurements in `<typeface>/measurements.json` (`views`: per-viewport measurements; `wholePages`: whole-page captures).
