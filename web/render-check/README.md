# Render check

Every pull request renders the site's surfaces and judges each render by rules a reviewer would otherwise check by eye. It runs in CI (the `render-check` job of `antwar ci`) on every pull request, and on manual dispatch.

```sh
npm run build:web
npm run render-check                     # writes out/render-check/report.md, report.json and renders/
```

## What it renders

Each surface at **1280 px** and **390 px** (phone), in **Roboto** and in **Liberation Sans**: 24 renders.

| Surface | Page |
|---|---|
| landing | `/` |
| watch | `/?watch=1`, with no live match |
| matches | `/?page=matches` |
| leaderboard | `/?page=leaderboard` |
| rules | `/rules`, as the server renders it before a map is drawn |
| replay-free-for-all | `/?replay=<id>&capture=1` of a public Free-for-all recording: the four-colony match HUD over the 3D board |

On Watch and the replay the client's animation clock (`performance.now`, which `web/src/clock.ts` reads) is the check's: it stands still except when the check steps it. Where the page shows a board, the check plays its recording to 10 s and draws that frame, so the HUD shows one fixed moment while it is judged and its renders are saved, and the 3D board never measures itself too slow in CI's software renderer and reloads as 2D. The replay also loads with `capture=1`, as `web/capture/` does, so its board draws only when stepped; Watch loads as a visitor sees it, because there `capture=1` also changes what the page shows with no live match.

The typeface is bound to `system-ui` and `sans-serif` through a per-run fontconfig that offers only that typeface (`fonts.ts`). Roboto comes from the pinned devDependency `@expo-google-fonts/roboto` (OFL); Liberation Sans from the Playwright image. The browser's own report of the fonts it drew with is checked on every render; a render drawn in another face is invalid and fails the run.

## Where its data comes from

The built site is served from disk with no server and no network (`serve.ts`). Every data request is answered from:

- `snapshot/`: responses recorded once from the public site (`--record`), with the time they were recorded;
- `fixtures.json`: responses the public site cannot give on demand, each labelled with what it stands for (no live match; short excerpts of two public recordings cut by `excerpt.ts`: a whole Free-for-all recording is over 100 MB. Re-recording the snapshot can change which recording is newest; cut an excerpt for the new one).

Any other request fails the render. To refresh the data: `npm run render-check -- --record`, then review and commit `snapshot/`. A new excerpt: `node --import ./src/ts-resolve.mjs web/render-check/excerpt.ts --id <replay id> --from <tick> --to <tick>`, and name it in `fixtures.json`.

## The rules (`rules.ts`)

A render fails on:

- **wrap**: a one-line item (a block holding only inline content: a name, a button; and every label and table heading, wherever it stands) laid out on two or more rendered lines, an explicit `<br>` included. Prose and headings may wrap.
- **clipped / cut / offscreen**: text cut by an overflow box (its own or an ancestor's), by an ellipsis, or by the viewport's sides; an image, board or control cut by an overflow box or the viewport (an image cropped by design with `object-fit` stays inside its box and is not cut). Each axis is judged on its own. A box that scrolls on an axis cuts nothing on it, because the reader can scroll to the content; past that box the content is judged where scrolling brings it, so a scroller cut by its own container still fails. Visually hidden screen-reader text is not judged.
- **sideways / page-wider**: a box that scrolls sideways, or a page wider than the viewport.
- **row-uneven / grid-uneven**: tiles of one kind, two or more in a grid, of unequal height in a row or across the grid. A grid laid out in one column (as at phone width) is judged too, however tall its tiles; only a column whose children each hold a heading and running text is a page's reading sections, not tiles.
- **tile-empty**: an empty band inside such a tile taller than 1.5 lines of its text.
- **part-uneven**: a tile part (an element with text) shown on some tiles of a grid but not others.
- **page-empty**: an empty band between parts of the page taller than 48 px, measured with every box that scrolls unrolled (its content counts where it lies, as the reader scrolls to it). The largest designed gap on main is 45 px; the band the Top matches review rejected measured 60 px.

A one-line item with under 8% of its width to spare is listed as a **tight** fit, not failed.

Each failure names its surface, width, typeface, rule, element (class path and text), measure and extent (lines for wrap, tiles missing the part for part-uneven, otherwise px), and the render that shows it outlined (red for new, amber for held).

The renders (`renders/`) are taken of the layout exactly as judged: the viewport never changes size. The first render is the surface as it opens; each further one brings the first finding not yet shown into view by scrolling the boxes that scroll and the page, never a box that clips (scrolling moves the layout, it does not lay it out again). The marks are drawn in a layer fixed to the viewport and clipped to it, so they add nothing to the page's size. A render is invalid, and the check fails, if the marks change the page's size, if a box that clips is not where it was judged, or if the surface judged again after its renders are saved finds anything different. In CI the failures are annotations on the pull request and the report is the job summary; the renders are the job's `render-check` artifact.

Wording, case and whether a part belongs on a tile at all are not measured: they stay with the reviewer.

## The held list (`held.json`)

Failures already on main are held: each entry holds one finding (one rule on one element and text of one surface, width and typeface) at the extent it was found, with the reason. A finding fails the check when it is not held, or when it measures further than its held extent: a held clipped name cut further, a held band grown taller. Held failures show as warnings. `--update-held` rewrites the list to this run's failures; changes to it are reviewed like code. The report lists held entries not matched (fixed, or now worse), so the list can shrink as fixes land.

## Options

`--dist <dir>` the built site (default `web/dist`); `--out <dir>`; `--surface <id>` (repeatable); `--fixtures <file>` extra labelled fixtures (repeatable); `--held <file>`; `--record`; `--update-held`; `--label <text>` names the build in the report. The browser is `CHROME_BIN`.
