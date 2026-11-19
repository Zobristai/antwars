# Render evidence: every Matches player line on one line

- **Base:** 10bba6177 (main, `10bba61` in file names). On main the five GPT-6.2 Astra Fast handles are not retired, so base shows no RETIRED badge.
- **Previous head:** e0fb1b5 (its stylesheet let a Recordings player's badges drop below the name).
- **Head:** e3bf6b77dc650787d6c0a152d19f1eec635ec7f3 (`e3bf6b7`), the pull request's head.
- **Pages:** Matches, Leaderboard and the landing page, at 1280 px and 390 px, in Roboto and Liberation Sans, on real data and on real data plus one labelled synthetic recording and leaderboard entry for the GPT-6.2 Astra Standard handle (not created yet).
- Rendered 2026-11-19T03:30:00Z to 2026-11-19T03:45:00Z. Evidence only: it states what was rendered and measured.

## The head's change

In `web/src/pages/archive.css`:
- The Recordings player line (`.d1p-rec-player`) no longer wraps. It is the same rule as on main: name, then badges, rating at the slot's end, one line.
- The Matches badge style (level, RETIRED, rating and result badges on Waiting, Live now and Recordings) has 2 px horizontal padding instead of 3 px. Size, tracking and gaps between parts are unchanged.

No text is shortened. The Leaderboard keeps its own badge style.

## One line, everywhere

On every page, width, typeface and data set, base and head:
- every Recordings player line and every Waiting or Live now player cell is on one line (Waiting and Live now are empty in this snapshot);
- no name is cut, no badge group is clipped, no badge breaks inside itself;
- every colony cell keeps 7 px inner padding on both sides, every gap between a line's parts is 7 px, no column head leaves its cell, and adjacent columns stand at least 7 px apart;
- no page error.

The Matches page is the same height at base and head: 1766 px (real) and 1815 px (synthetic) at 1280; 2556 px and 2639 px at 390.

The parked row that previously dropped, **GPT-6.2 Astra MEDIUM (Fast bolt) RETIRED 1500**, now needs 228.1 of 233 px in Liberation Sans at 1280 (was 233.1). Crops: `<typeface>/matches/matches-<build>-<width>-astra-medium-row1.png`.

## Fits under 8% to spare (head)

Spare = (available − needed) / available, for each Recordings player line laid out on one line.

| Typeface | Width | Line | Needs / has px | Spare | Base |
|---|---|---|---|---|---|
| Liberation Sans | 1280 | GPT-6.2 Astra MEDIUM (bolt) RETIRED 1500 | 228.1 / 233 | 2.1% | no RETIRED badge |
| Liberation Sans | 1280 | CedarGrove GPT-6.1 Terra MAX (bolt) 1500 | 224.9 / 233 | 3.5% | 2.2% |
| Liberation Sans | 1280 | GPT-6.2 Astra XHIGH (bolt) RETIRED (3 rows) | 219 / 233 | 6.0% | no RETIRED badge |
| Liberation Sans | 1280 | CedarGrove Muse Wonder MAX 1500 | 216.9 / 233 | 6.9% | 5.2% |
| Liberation Sans | 390 | GPT-6.2 Astra MEDIUM (bolt) RETIRED 1500 | 228.1 / 247 | 7.6% | no RETIRED badge |
| Roboto | 1280 | GPT-6.2 Astra MEDIUM (bolt) RETIRED 1500 | 221.3 / 233 | 5.0% | no RETIRED badge |
| Roboto | 1280 | CedarGrove GPT-6.1 Terra MAX (bolt) 1500 | 216.3 / 233 | 7.2% | 5.9% |

The same lines on the landing page's Recordings card measure the same. In the synthetic set the MEDIUM row appears twice on Matches (the real row and the synthetic recording's opponent).

The page-wide item check (headings, buttons, chips, badges, one-line items) lists under 8% at head:
- Liberation Sans 1280, Matches and landing: the name "GPT-6.2 Astra" in the MEDIUM row, 6.2% (the name's own slack inside the line).
- Liberation Sans 390, Leaderboard and landing: the "NEW: Your agent can challenge the top models" button, 2.8%, the same at base.
- The landing page's "RATED MATCHES" column heading wraps at 1280 in both typefaces, the same at base.

Nothing else wraps, is cut or overlaps.

## The new label: GPT-6.2 Astra Standard (synthetic)

"GPT-6.2 Astra Standard" HIGH, no bolt, one line and uncut:
- Matches and landing Recordings: 15.7% spare in Roboto and 14.2% in Liberation Sans at 1280; 20.5% and 19.1% at 390.
- Leaderboard: one line, uncut, at both widths.

Crops are under `<typeface>/*-synthetic/`. At 1280 on Matches the label's row is `matches-synthetic/matches-e3bf6b7-1280-astra-medium-row1.png` (that recording holds both players).

## Typeface the browser reported

The browser's font report for every visible text part matches the set's typeface, apart from one landing-page part in each set, the same at base and head: in the Roboto set the "→" arrow falls back to Liberation Sans (1 glyph); in the Liberation Sans set the agent-connection address is drawn in Roboto Medium (25 glyphs), because that element names its own family. Counts are in `<typeface>/measurements.json`.

## Data and method

- **Real snapshot:** the public antwars.ai API's answers recorded 2026-11-19T02:04:31Z to 2026-11-19T02:04:49Z, replayed offline for every build; page clock pinned at 2026-11-19T02:05:00Z.
- **Builds:** `git archive` of each commit, built with `vite build --config web/vite.config.ts`.
- **Browser:** Playwright with chrome-headless-shell build 1254, every request routed offline. Viewports 1280x800 and 390x844 (mobile, touch). Roboto Regular/Medium/Bold TTF SHA-256 as in the earlier set.
- **Files:** `<typeface>/<page>[-synthetic]/<page>-<build>-<width>-full.png` (whole pages), crops beside them, measurements in `<typeface>/measurements.json`.
