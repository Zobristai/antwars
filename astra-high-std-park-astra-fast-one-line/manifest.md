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
- every Recordings player line and every Waiting or Live now player cell is on one line (Waiting and Live now are empty in the real snapshot; populated by fixtures in the set below);
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

## Waiting and Live now, populated by fixtures

Added 2026-11-19. Rendered 2026-11-19T03:40:00Z to 2026-11-19T03:44:00Z. Same base (`10bba61`) and head (`e3bf6b7`), same browser and method. Matches page only, at 1280 px and 390 px, in Roboto and Liberation Sans.

**Data.** The synthetic set's snapshot, except that the two empty lists are replaced by fixtures. These are invented rows, not recorded answers:
- `fixtures/watch-queue.fixture.json`: Waiting holds GPT-6.2 Astra Standard (high, no tier) queued alone in the Index 1v1 queue, and one Index 1v1 lobby seating GPT-6.2 Astra Standard against the parked GPT-6.2 Astra medium (Fast).
- `fixtures/watch-catalog.fixture.json`: Live now holds two live Index 1v1 matches. One is GPT-6.2 Astra Standard against the parked GPT-6.2 Astra medium (Fast). The other is the parked GPT-6.2 Astra xhigh (Fast) against GPT-6.2 Astra Standard.

Ratings are copied from the synthetic leaderboard entries. A parked handle cannot be queued or launched at head, so the parked rows show how the page would draw one. At base the new handle is not listed yet, so it shows as "Unlisted model", and no Fast row carries RETIRED.

**Result, base and head, every width and typeface:**
- **Two-line rows:** none. Every player cell is on one line: 7 Waiting and Live now cells and 46 Recordings lines.
- **Cut text:** none. No name is cut. No badge group is clipped, no badge breaks inside itself, and no cell overflows.
- **Item check:** no heading, button, chip or badge wraps, is cut or overlaps.
- **Padding check:** no cell fails.
- **Page errors:** none.
- **Page heights:** the same at base and head, 2032 px at 1280 and 3003 px at 390.
- **Typefaces:** the browser reports every visible text part drawn in the set's typeface (Roboto or Roboto Medium in the Roboto set, Liberation Sans in the other).

**Fits under 8% to spare (head), Waiting and Live now.** Spare = (available − needed) / available, for each player cell laid out on one line. At 1280 every cell has at least 34.6% to spare (349 px wide). At base every cell has at least 26.1%, because no Fast row carries RETIRED.

| Typeface | Width | Cell | Needs / has px | Spare | Where |
|---|---|---|---|---|---|
| Liberation Sans | 390 | GPT-6.2 Astra MEDIUM (bolt) RETIRED 1338 | 228.1 / 237 | 3.8% | Waiting lobby, Live now row 1 |
| Liberation Sans | 390 | GPT-6.2 Astra XHIGH (bolt) RETIRED 1639 | 219 / 237 | 7.6% | Live now row 2 |
| Roboto | 390 | GPT-6.2 Astra MEDIUM (bolt) RETIRED 1338 | 221.8 / 237 | 6.4% | Waiting lobby, Live now row 1 |

GPT-6.2 Astra Standard HIGH 1662 needs 196.8 px in Roboto at 390, which leaves 17% to spare. Recordings in this set measure the same as the synthetic set above. The page-wide item check lists the name "GPT-6.2 Astra" at 6.2%, in Liberation Sans at 1280 only, inside the Recordings MEDIUM rows as before.

**Files:** under `<typeface>/matches-waiting-live/`:
- `matches-<build>-<width>-waiting-card.png` and `-live-card.png`: the two cards whole;
- `-waiting-row<n>.png` and `-live-row<n>.png`: each row holding a GPT-6.2 Astra player;
- `matches-<build>-<width>-full.png`: the whole page.

Measurements are in `<typeface>/measurements-waiting-live.json`.

## Data and method

- **Real snapshot:** the public antwars.ai API's answers recorded 2026-11-19T02:04:31Z to 2026-11-19T02:04:49Z, replayed offline for every build; page clock pinned at 2026-11-19T02:05:00Z.
- **Builds:** `git archive` of each commit, built with `vite build --config web/vite.config.ts`.
- **Browser:** Playwright with chrome-headless-shell build 1254, every request routed offline. Viewports 1280x800 and 390x844 (mobile, touch). Roboto Regular/Medium/Bold TTF SHA-256 as in the earlier set.
- **Files:** `<typeface>/<page>[-synthetic]/<page>-<build>-<width>-full.png` (whole pages), crops beside them, measurements in `<typeface>/measurements.json`.
