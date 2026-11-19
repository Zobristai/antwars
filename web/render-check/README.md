# Render check

Every pull request renders the site's surfaces and judges each render by rules a reviewer would otherwise check by eye. It runs in CI (the `render-check` job of `antwar ci`) on every pull request, and on manual dispatch.

```sh
npm run build:web
npm run render-check                     # writes out/render-check/report.md, report.json and renders/
```

## What it renders

Each surface at **1280 px** and **390 px** (phone), in **Roboto** and in **Liberation Sans**: 28 renders.

| Surface | Page |
|---|---|
| landing | `/` |
| watch | `/?watch=1`, with no live match |
| matches | `/?page=matches` |
| waiting | `/?page=matches` with agents waiting and matches live (`waiting-fixture.json`), so the Waiting and Live now tables have rows; the page's clock is fixed at the snapshot's time, so the times it shows are the same on every run |
| leaderboard | `/?page=leaderboard` |
| rules | `/rules`, as the server renders it before a map is drawn |
| replay-free-for-all | `/?replay=<id>&capture=1` of a public Free-for-all recording: the four-colony match HUD over the 3D board |

On Watch and the replay the client's animation clock (`performance.now`, which `web/src/clock.ts` reads) is the check's: it stands still except when the check steps it. Where the page shows a board, the check plays its recording to 10 s in 100 ms steps, lets what that frame loads finish (the HUD's icons, the board's shaders) and draws it again, so the HUD shows one fixed moment while it is judged and its renders are saved, and the 3D board never measures itself too slow in CI's software renderer and reloads as 2D. The replay also loads with `capture=1`, as `web/capture/` does, so its board draws only when stepped. The replay must reach a ready, playing HUD: a board that fails to load or is not ready within 30 s, a recording that errors or is still at its first tick after 10 s, or no match HUD on screen makes its render invalid, naming the page, width and typeface; Watch loads as a visitor sees it, because there `capture=1` also changes what the page shows with no live match.

The typeface is bound to `system-ui` and `sans-serif` through a per-run fontconfig that offers only that typeface (`fonts.ts`). Roboto comes from the pinned devDependency `@expo-google-fonts/roboto` (OFL); Liberation Sans from the Playwright image. The browser's own report of the fonts it drew with is checked on every render; a render drawn in another face is invalid and fails the run.

## Where its data comes from

The built site is served from disk with no server and no network (`serve.ts`). Every data request is answered from:

- `snapshot/`: responses recorded once from the public site (`--record`), with the time they were recorded. A player handle written `stand-in-handle-<n>` (here and in `waiting-fixture.json`) is a stand-in for a recorded one. The recorded `/matches` page holds only matches the public lists still show: the test matches they hide (`src/replays/testBackfillIds.ts`) are removed from it, with its continuation, so the page ends there;
- `fixtures.json`: responses the public site cannot give on demand, each labelled with what it stands for (no live match; short excerpts of two public recordings cut by `excerpt.ts`: a whole Free-for-all recording is over 100 MB. An excerpt is 11 s of its recording (110 ticks), so it runs past the moment its HUD is judged: the replay must not reach its last tick, where its HUD says the recording ended, and Watch with no live match starts its stand-in recording again once its last message arrives. Each excerpt is committed as readable text (`replay-text.ts`): every line a field of one decoded message, none longer than 4,000 bytes, with an ant's position and other fields written as its change since the tick before, in files of at most 64 KB read in order (`<id>-<from>-<to>/01.replay.jsonl`, `02.replay.jsonl`, ...), so each file can be read whole; at run time the server packs it with the game's own encoder into the bytes `/replays/<id>` serves and refuses to start unless they match the excerpt's recorded `sha256`. Re-recording the snapshot can change which recording is newest; cut an excerpt for the new one).

Any other request fails the render. To refresh the data: `npm run render-check -- --record`, then review and commit `snapshot/`. A new excerpt: `node --import ./src/ts-resolve.mjs web/render-check/excerpt.ts --id <replay id> --from <tick> --to <tick>`, and name its files, in order, and its digest in `fixtures.json`.

## The rules (`rules.ts`)

A render fails on:

- **wrap**: a one-line item (a block holding only inline content, such as a name; and every label, button, table heading and card state line (`p.d1p-state`), wherever it stands and however long its text) laid out on two or more rendered lines, an explicit `<br>` included. A part positioned out of the line (a tooltip over a badge) is not one of its lines. A table heading built of two or more stacked blocks (a date over its time) is judged block by block, each as one line. Prose and headings may wrap.
- **clipped / cut / offscreen**: text cut by an overflow box (its own or an ancestor's), by an ellipsis, or by the viewport's sides; an image, board or control cut by an overflow box or the viewport (an image cropped by design with `object-fit` stays inside its box and is not cut). Each axis is judged on its own. A box that scrolls on an axis cuts nothing on it, because the reader can scroll to the content; past that box the content is judged where scrolling brings it, so a scroller cut by its own container still fails. Visually hidden screen-reader text is not judged.
- **sideways / page-wider**: a box that scrolls sideways, whatever overflows it (text, an image, a board), or a page wider than the viewport.
- **row-uneven / grid-uneven**: tiles of one kind, two or more in a grid, of unequal height in a row or across the grid. A grid laid out in one column (as at phone width) is judged too, however tall its tiles and whatever they hold. A tile is a child with a drawn edge or background (or wrapping one such box); children with neither, such as a page's plain reading sections, are not tiles.
- **tile-empty**: an empty band inside such a tile taller than 1.5 lines of its text.
- **part-uneven**: a tile part (an element with text) shown on some tiles of a grid but not others.
- **page-empty**: an empty band between parts of the page taller than 48 px, measured with every box that scrolls unrolled (its content counts where it lies, as the reader scrolls to it). The largest designed gap on main is 45 px; the band the Top matches review rejected measured 60 px.

A one-line item with under 8% of its width to spare is listed as a **tight** fit, not failed.

Each failure names its surface, width, typeface, rule, element (class path and text), measure and extent (lines for wrap, tiles missing the part for part-uneven, otherwise px), and the render that shows it outlined (red for new, amber for held).

The renders (`renders/`) are taken of the layout exactly as judged: the viewport never changes size. The first render is the surface as it opens; each further one, with no limit on their number, brings the first finding not yet shown into view by scrolling the boxes that scroll and the page, never a box that clips (scrolling moves the layout, it does not lay it out again). Every finding is linked to a render that shows it; a finding no scrolling can bring into view (past the edge of a fixed HUD) is linked to the render where scrolling stopped and is said in the report to be outside it. The marks are drawn in a layer fixed to the viewport and clipped to it, so they add nothing to the page's size. A render is invalid, and the check fails, if the marks change the page's size, if a box that clips is not where it was judged, or if the surface judged again after its renders are saved finds anything different. In CI the failures are annotations on the pull request and the report is the job summary; the renders are the job's `render-check` artifact.

Wording, case and whether a part belongs on a tile at all are not measured: they stay with the reviewer.

## The held list (`held.json`)

Failures already on main are held: each entry holds one finding (one rule on one element and text of one surface, width and typeface) at the extent it was found, with the reason. A finding fails the check when it is not held, or when it measures further than its held extent: a held clipped name cut further, a held band grown taller. Held failures show as warnings. `--update-held` rewrites the list to this run's failures; changes to it are reviewed like code. The report lists held entries not matched (fixed, or now worse), so the list can shrink as fixes land.

## Options

`--dist <dir>` the built site (default `web/dist`); `--out <dir>`; `--surface <id>` (repeatable); `--fixtures <file>` extra labelled fixtures (repeatable); `--held <file>`; `--record`; `--update-held`; `--label <text>` names the build in the report. The browser is `CHROME_BIN`.
