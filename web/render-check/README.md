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
| replay-free-for-all | `/?replay=<id>` of a public Free-for-all recording: the four-colony match HUD over the 3D board |

The typeface is bound to `system-ui` and `sans-serif` through a per-run fontconfig that offers only that typeface (`fonts.ts`). Roboto comes from the pinned devDependency `@expo-google-fonts/roboto` (OFL); Liberation Sans from the Playwright image. The browser's own report of the fonts it drew with is checked on every render; a render drawn in another face is invalid and fails the run.

## Where its data comes from

The built site is served from disk with no server and no network (`serve.ts`). Every data request is answered from:

- `snapshot/`: responses recorded once from the public site (`--record`), with the time they were recorded;
- `fixtures.json`: responses the public site cannot give on demand, each labelled with what it stands for (no live match; short excerpts of two public recordings cut by `excerpt.ts`: a whole Free-for-all recording is over 100 MB. Re-recording the snapshot can change which recording is newest; cut an excerpt for the new one).

Any other request fails the render. To refresh the data: `npm run render-check -- --record`, then review and commit `snapshot/`. A new excerpt: `node --import ./src/ts-resolve.mjs web/render-check/excerpt.ts --id <replay id> --from <tick> --to <tick>`, and name it in `fixtures.json`.

## The rules (`rules.ts`)

A render fails on:

- **wrap**: a one-line item (a block holding only inline content: a name, a label, a button) laid out on two or more lines. Prose and headings may wrap.
- **clipped / cut / offscreen**: text cut by an overflow box, by an ellipsis, or by the viewport's sides. Visually hidden screen-reader text is not judged.
- **sideways / page-wider**: a box that scrolls sideways, or a page wider than the viewport.
- **row-uneven / grid-uneven**: tiles of one kind, two or more side by side, of unequal height in a row or across the grid.
- **tile-empty**: an empty band inside such a tile taller than 1.5 lines of its text.
- **part-uneven**: a tile part (an element with text) shown on some tiles of a grid but not others.
- **page-empty**: an empty band between parts of the page taller than 48 px. The largest designed gap on main is 45 px; the band the Top matches review rejected measured 60 px.

A one-line item with under 8% of its width to spare is listed as a **tight** fit, not failed.

Each failure names its surface, width, typeface, rule, element (class path and text) and measure, and is outlined on that render (`renders/`, red for new, amber for held). In CI the failures are annotations on the pull request and the report is the job summary; the renders are the job's `render-check` artifact.

Wording, case and whether a part belongs on a tile at all are not measured: they stay with the reviewer.

## The held list (`held.json`)

Failures already on main are held: each entry holds a number of findings of one rule on one element of one surface, width and typeface, with the reason. A failure fails the check only when it is not held, or found more often than its count. Held failures show as warnings. `--update-held` rewrites the list to this run's failures; changes to it are reviewed like code. The report lists held entries no longer found, so the list can shrink as fixes land.

## Options

`--dist <dir>` the built site (default `web/dist`); `--out <dir>`; `--surface <id>` (repeatable); `--fixtures <file>` extra labelled fixtures (repeatable); `--held <file>`; `--record`; `--update-held`; `--label <text>` names the build in the report. The browser is `CHROME_BIN`.
