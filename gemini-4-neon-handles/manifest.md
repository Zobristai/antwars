# Render evidence: four Gemini 4 Neon house handles

- **Base:** 10bba6177f3fd9de4e00f4df1de9948db74ab961 (main, `10bba61` in file names).
- **Head:** 7997aafa98f41ec299de84450f4ec62c8b62c680 (`7997aaf`), the pull request's head.
- **Pages:** Matches, Leaderboard and the landing page, at 1280 px and 390 px, in Roboto and Liberation Sans, on real data and on real data plus fixture rows for the new handles (which do not exist live yet).
- Evidence only: it states what was rendered and measured.

## Fixture rows

The fixture set (`<typeface>/<page>-fixture/`) is the real snapshot plus these labelled fixture rows; nothing else in it differs from the real set:

- Leaderboard: four entries, `antwars/gemini-4-neon-xhigh` (1662, 1–0), `antwars/gemini-4-neon-high` (1662, 1–0), `antwars/gemini-4-neon-medium` (1338, 0–1) and `antwars/gemini-4-neon-low` (1338, 0–1), each with one rated match. They land at ranks 15, 16, 41 and 45.
- Recordings: two index 1v1 recordings, xhigh against low and high against medium, both started at 1500.

## The new label

On head, every fixture row reads **Gemini 4 Neon** with its level badge, as its own entry:

- Leaderboard: all four rows on one line and uncut, at both widths and in both typefaces. Crops: `<typeface>/leaderboard-fixture/leaderboard-7997aaf-<width>-neon-<n>.png`.
- Matches and landing Recordings player lines: all four on one line, uncut, no badge clipped or broken. Tightest is "Gemini 4 Neon MEDIUM 1500": 171.1 of 233 px (26.6% spare) in Roboto and 172.8 of 233 px (25.8%) in Liberation Sans at 1280; 30.7% and 30.0% at 390. Crops: `<typeface>/matches-fixture/matches-7997aaf-<width>-neon-<n>.png`.

On base the label does not exist: no "Gemini 4 Neon" text appears in any base render, and the four Recordings player lines read "Unlisted model".

## Two lines and cut text

On every page, width, typeface and data set, base and head:

- no Matches or landing player line takes two lines, no name is cut, no badge group is clipped and no badge breaks;
- every colony cell keeps its inner padding, no column head leaves its cell, and no page error.

Real-data pages are the same height at base and head. The only Recordings lines under 8% spare are existing rows, unchanged from base: "CedarGrove GPT-6.1 Terra MAX (Fast) 1500" at 2.2% and "CedarGrove Muse Wonder MAX 1500" at 5.2% in Liberation Sans at 1280, the former at 7.7% at 390, and 5.9% in Roboto at 1280.

## Data and method

- **Real snapshot:** the public antwars.ai API's answers (leaderboard, matches, watch catalog and queue) recorded 2026-11-19T03:23:27Z to 2026-11-19T03:23:44Z, replayed offline for every build; page clock pinned at 2026-11-19T03:30:00Z.
- **Builds:** `git archive` of each commit, built with `vite build --config web/vite.config.ts`.
- **Browser:** Playwright with chrome-headless-shell build 1254, every request routed offline. Viewports 1280x800 and 390x844 (mobile, touch).
- **Files:** `<typeface>/<page>[-fixture]/<page>-<build>-<width>.png` (viewport), `-full.png` (whole page), crops beside them; measurements in `<typeface>/measurements.json`.
