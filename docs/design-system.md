# Design system

The site's shared tokens and components live in `web/src/design-system/`. Its first component is the Top matches tile on
the Watch page.

## Tokens

`web/src/design-system/tokens.css` sets every value as a `--aw-*` custom property on the page root `.d1p` (pages/chrome.ts), not on `:root`, so it
changes no value outside the page: surfaces, ink, rules, the one
accent and the alert, one colour per colony, the amber wash, the winner's band fill, the type family and its size and line
height pairs, weights and tracking, a 4 px spacing grid, radii, tap targets and the layout widths. Use a token rather than
a literal, inside `.d1p`. The tap target `--aw-tap` is 36 px, and 44 px on a touch screen (`pointer: coarse`). Type sizes are in `rem`, so a browser's text-size setting enlarges them, and breakpoints are in `em`, so they
move with it.

## The Top matches tile

`web/src/design-system/top-match-tile.ts` draws one tile, `top-match-tile.css` lays it and its grid out. The Watch page
with no live match (`web/src/pages/top-matches.ts`) shows the hand-picked list ([top-matches.md](top-matches.md)) as a grid
of these tiles in the site's own page frame: the title and the reason no live match shows stand in the page band, the grid
sits on the page under it with no card, and All recordings is a text link under the grid.

Each tile is one link to its match's replay. It plays nothing itself. Every tile has the same five one-line rows, in this
order:

1. the game type, and for a team match its seats in words ("2 seats each");
2. the winner's player line, on a band of its colony's colour, the only colony colour on the tile;
3. the other side's player line;
4. how the match ended;
5. the date, with the match's length on the right.

A player line is the builder's name in bold, exactly as stored, then the model, then the effort badge, with Fast drawn as
a bolt inside it. It comes from the same source the Matches page draws its players from. A side fielding more than one
seat has one edge rule per seat at the left of its line. No rating is shown. A retired model is marked in the tile's
accessible name and tooltip, not on the tile.

## Layout rules

- **Grid**: four columns from 46.125rem (738 px), two under it, one under 24.25em. Every cell is the same size.
- **Page edge**: 24 px, 16 px under 64rem, 12 px between 46.125rem and 52rem, 8 px in one column. The grid gap is 12 px,
  8 px under 64rem and 4 px between 46.125rem and 52rem.
- **Two columns on a phone** (24.25em to 46.125rem): page edge 12 px and grid gap 4 px, not 16 and 8. The design measured its
  widest player line with web fonts; the site draws with the visitor's system fonts, where that line (Muse Wonder Full 1.0
  with its effort badge, in Liberation Sans) needs 157.4 px and 16 and 8 px leave 157, so its badge would wrap at 390 px.
  12 and 4 px give it 163. One column, under 24.25em, keeps its 8 px edge and the flush list below.
- **Four columns from 46.125rem**, not the design's 46rem, for the same reason: at 736 and 737 px four columns leave
  that line too little width in Liberation Sans and its badge wraps, so those two widths keep two columns.
- **Flush list**: under 12em (a phone at 200 % zoom, or with its text doubled) the page edge goes to 0 and the tiles lie
  flush as a list, with a rule between them, so each line keeps the width it needs.
- **One line per row**: every row fits on one line from 320 px at the default text size. A 2v2 player line keeps its one
  line at 320 and 390 px, at 200 % zoom and with doubled text, in Roboto and Liberation Sans. Past that, nothing is cut:
  the badges move to the next line as one unit and a long name wraps between words.

The render check (`web/render-check/`) judges the Watch page at 390 and 1280 px in both typefaces against these rules.
