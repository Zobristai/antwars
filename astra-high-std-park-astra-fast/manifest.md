# Render evidence: GPT-6.2 Astra Standard handle, parked GPT-6.2 Astra Fast handles, Recordings badge drop

- **Base:** 7df3f004d8d86d0387c12a2112173f00fd10da09 (main, the pull request's base).
- **Previous head:** c3cf0910752b8090aabaf7f2a5dc3dc71f2009e8 (label, park and launchable-list change only).
- **Head:** 68b09fd2107852ff25b2b47ef353d4fabbd3fbea (adds one Recordings layout rule; the pull request's head).
- **Pages:** Matches, Leaderboard and the landing page, at 1280 px and 390 px, in Roboto and Liberation Sans.
- Rendered 2026-11-19T02:19:00Z to 2026-11-19T02:56:00Z. Evidence only. It states what was rendered and measured and gives no verdict.

## The head's layout change

One rule in `web/src/pages/archive.css`: a Recordings player line (`.d1p-rec-player`) may wrap. When the name and the badge group do not fit on one line, the badge group moves below the name, all in one piece. The badge group (`.d1p-rec-badges`) itself does not wrap, and each badge stays `white-space: nowrap`, so no badge breaks across two lines. A line that fits stays on one line. No text is shortened. The rest of the page is unchanged.

## Rows that now take two lines (head)

Only one player line takes two lines, in every run, and only in **Liberation Sans at 1280 px**: **"GPT-6.2 Astra" MEDIUM (Fast bolt) RETIRED 1500**. On one line it would need 233.1 px, and the slot has 233 px.

| Data | Page | Occurrences |
|---|---|---|
| real | Matches | 1 |
| synthetic | Matches | 2 (the real row, plus the synthetic recording's opponent) |
| synthetic | landing | 1 |

On each occurrence:
- The name "GPT-6.2 Astra" is shown in full.
- The badge group MEDIUM (bolt) RETIRED drops whole onto the line below the name.
- The rating stays at the slot's end.
- No badge breaks inside itself. The measurement checks each badge, seat count and rating badge for more than one line box, and finds none.

The Matches page in Liberation Sans at 1280 px is 4 px taller per affected row: 1766 px at base, 1770 px at head on real data.

No player line takes two lines in Roboto, at 390 px, or at base. See `matches/*-astra-medium-row1.png` for the row at each build.

## What the previous head did with that row

At c3cf091, in Liberation Sans at 1280 px, the same row needed 233.1 of 233 px on one line. The name was cut with an ellipsis to "GPT-6.2 As…" (`liberation-sans/matches/matches-c3cf091-1280-astra-medium-row1.png` in the render set). The head fixes this. Base shows the row as "GPT-6.2 Astra MEDIUM (bolt) 1500", with no RETIRED badge, on one line.

## Fits under 8% to spare (head)

Spare = (available − needed) / available, measured for each Recordings player line as it would need on one line.

| Typeface | Width | Line | Needs / has px | Spare | At base |
|---|---|---|---|---|---|
| Liberation Sans | 1280 | CedarGrove GPT-6.1 Terra MAX (bolt) 1500 | 227.9 / 233 | 2.2% | same, 2.2% |
| Liberation Sans | 1280 | GPT-6.2 Astra XHIGH (bolt) RETIRED (3 rows) | 224 / 233 | 3.9% | 28.9%, no RETIRED badge |
| Liberation Sans | 1280 | CedarGrove Muse Wonder MAX 1500 | 220.9 / 233 | 5.2% | same, 5.2% |
| Liberation Sans | 1280 | GPT-6.2 Astra HIGH (bolt) RETIRED (2 rows, Matches; 1 on landing) | 217.2 / 233 | 6.8% | 31.8% |
| Liberation Sans | 1280 | GPT-6.2 Astra LOW (bolt) RETIRED (3 rows, Matches; 1 on landing) | 215.3 / 233 | 7.6% | 32.6% |
| Liberation Sans | 390 | GPT-6.2 Astra MEDIUM (bolt) RETIRED 1500 | 233.1 / 247 | 5.6% | 29.2% |
| Liberation Sans | 390 | CedarGrove GPT-6.1 Terra MAX (bolt) 1500 | 227.9 / 247 | 7.7% | same, 7.7% |
| Roboto | 1280 | GPT-6.2 Astra MEDIUM (bolt) RETIRED 1500 | 226.3 / 233 | 2.9% | 26.1% |
| Roboto | 1280 | CedarGrove GPT-6.1 Terra MAX (bolt) 1500 | 219.3 / 233 | 5.9% | same, 5.9% |
| Roboto | 1280 | GPT-6.2 Astra XHIGH (bolt) RETIRED (3 rows) | 217.2 / 233 | 6.8% | 30.1% |

The page-wide item check (headings, buttons, chips, badges, one-line items) gives these items under 8% at head:
- Roboto 1280, Matches: the badge group MEDIUM (bolt) RETIRED, 107.5 of 113.8 px (5.5%).
- Liberation Sans 1280, Matches: three XHIGH (bolt) RETIRED groups (7.2%), "CedarGrove" (6.2%) and "GPT-6.1 Terra" (5.9%; 6.9% at base).
- Liberation Sans 390, Leaderboard and landing: the "NEW: Your agent can challenge the top models" button (2.8%, the same at base).

The landing page's "RATED MATCHES" column heading wraps at 1280 in both typefaces. It does the same at base. No other item wraps, is cut or overlaps another, at base or head.

## The new label: GPT-6.2 Astra Standard

The handle has not been created yet, so the live data has no row for it. A labelled synthetic supplement adds one recording (GPT-6.2 Astra Standard HIGH, no tier, against GPT-6.2 Astra medium Fast) and one leaderboard entry. Everything else is the real snapshot.

At head the label reads "GPT-6.2 Astra Standard" with a HIGH badge and no bolt. It is one line and uncut on:
- Matches Recordings: 14.0% spare in Roboto and 12.5% in Liberation Sans at 1280; 18.9% and 17.5% at 390.
- The landing page's Recordings card: the same figures.
- The Leaderboard row: 36.4% and 33.7% at 1280. At 390 its label is on one line and uncut in both typefaces.

Crops are in `<typeface>/new-label/`. At 390, the phone layout puts the badges on their own line under the name, as for every leaderboard row.

## Data

- **Real snapshot:** each non-static request (`/matches`, `/api/leaderboard` house 1v1, `/watch/queue`, `/watch/catalog`) was answered once by the public antwars.ai API at 2026-11-19T02:04:31Z to 2026-11-19T02:04:49Z, then replayed offline for every build. The page clock is pinned at 2026-11-19T02:05:00Z. Live now and Waiting are empty in this snapshot.
- **Synthetic supplement:** the real snapshot plus the one invented recording and one invented leaderboard entry described above.

## How each image was made

- **Builds:** `git archive` of each commit, built with `vite build --config web/vite.config.ts` using the repository's installed dependencies.
- **Browser:** Playwright with chrome-headless-shell build 1254. All requests were routed offline to the build's static files and the snapshot. No run had a missing request, page error or console error.
- **Typefaces:** fontconfig maps system-ui and sans-serif to the named face. The Roboto Regular, Medium and Bold TTF SHA-256 values are:
  - 9f300202f482ad59f8b13bc3131a295744d14fd530fa3765a0a11ec87264d203 (Regular)
  - 80ce163ec5ecd91a883aa20e80d31dc74971b55cf658dd7c5e8d21f4e9fcb417 (Medium)
  - 44f13e570a8b3fc42240abfcb3d72fe298f3dd6a25db0c78d0c2495dbd0e9121 (Bold)
- **Font check:** the browser's font report for every visible text part shows each set in its named face. The exception is one landing-page part in the other face, at base and head alike.
- **Viewports:** 1280x800 desktop; 390x844 phone (mobile, touch).
- **Full-page images:** `*-full.png` grows the viewport to the page's height. Every page is under 6,200 px.

## Files

- `<typeface>/<page>/<page>-<build>-<width>-full.png`: whole pages, real data. Page is matches, leaderboard or landing; build is 7df3f00 (base) or 68b09fd (head).
- `<typeface>/<page>-synthetic/…`: the same pages with the synthetic supplement.
- `<typeface>/matches/matches-<build>-<width>-astra-medium-row1.png`: the GPT-6.2 Astra medium recording's row at base, previous head (c3cf091) and head.
- `<typeface>/new-label/<page>-68b09fd-<width>-astra-standard-<n>.png`: the row carrying the new label.
- `<typeface>/measurements.json`: for every run, each Recordings player line, with its line count, whether its name is cut, whether its badge group is clipped, whether any badge breaks inside itself, and its need, available width and spare. It also lists every item wrapped, cut, or under 8% spare.
