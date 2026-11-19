# Design system

The site's shared tokens and components live in `web/src/design-system/`. Its first component is the Top matches tile on
the Watch page.

## Tokens

`web/src/design-system/tokens.css` sets every value as a `--aw-*` custom property on the page root `.d1p` (pages/chrome.ts), not on `:root`, so it
changes no value outside the page: surfaces, ink, rules, the one
accent and the alert, one colour per colony, the amber wash, the winner's band fill, the type family and its size and line
height pairs, weights and tracking, a 4 px spacing grid, radii, tap targets and the layout widths. Use a token rather than
a literal, inside `.d1p`. The tap target `--aw-tap` is 36 px, and 44 px on a touch screen (`pointer: coarse`) and wherever `web/index.html` sets
44 px: a window 700 px wide or less, or a phone held sideways (500 px tall or less and wider than 500 px). Type sizes are in `rem`, so a browser's text-size setting enlarges them, and breakpoints are in `em`, so they
move with it.

## The Top matches tile

`web/src/design-system/top-match-tile.ts` draws one tile, `top-match-tile.css` lays it and its grid out. The Watch page
with no live match (`web/src/pages/top-matches.ts`) shows the hand-picked list ([top-matches.md](top-matches.md)) as a grid
of these tiles in the site's own page frame: the title and the reason no live match shows stand in the page band, the grid
sits on the page under it with no card, and All recordings is a text link under the grid.

Each tile is one link to its match's replay. It plays nothing itself. With results shown, every tile has the same rows, in this order:

1. the game type, and for a team match its seats in words ("2 per side");
2. the winner's side, on a band of its colony's colour, the only colony colour on the tile;
3. the other side, or in a free-for-all each other side, one under another;
4. how the match ended, in the site's own words without the tie-break step it was decided on (" · decided on …"),
   and on a free-for-all also without the leading "Last colony standing"; the tile's accessible name keeps the full words;
5. the date, with the match's length on the right.

### Results hidden

By default the tiles hide every result. A hidden tile shows only its game type, its sides in colony order (the order
Matches lists colonies in) and its date, at its foot: no winner band, no colony colour, seat marks grey on every side, no
"how it ended" row and no length (a length equal to the time limit would say the match went to time). The result is not
drawn and then hidden: the tile's markup and its accessible name carry none of it. The accessible name names the sides
joined by "versus" (a free-for-all lists its colonies), then the type and the date. Hidden tiles are 106 px tall at the
default text size; shown, 122 px.

One **Show results** button, beside the reason no live match shows, shows every tile's result at once, as the rows above
draw it, and becomes **Hide results**. It stands only while the grid has tiles. Its visible text is its accessible name and it
controls the grid, which holds the state (`data-results="hidden"` or `"shown"`). The choice is remembered in this browser
(local storage, `aw.topMatches.showResults`) and read before the grid is first drawn; a visitor who never chose, or whose
browser blocks storage, sees results hidden.

A player line is the builder's name in bold, exactly as stored, then the model, then the effort badge, with Fast drawn as
a bolt inside it. It comes from the same source the Matches page draws its players from. A side is one player line, and
a side fielding more than one seat has one mark per seat at the left of its line: two seats, two full-height edge rules;
three or four seats, small marks two across and two down in the same space (three seats leave the lower right one out),
so the side keeps its one line and its text does not move. Where its seats differ (different
builders, or one builder on different models or levels), the side has one complete player line per seat group, grouped and
ordered as Matches groups them, each with one mark per seat it stands for; every name shows exactly as stored, nothing
is shortened to a count, and the tile's accessible name names every group. No rating is shown. A retired model is marked in
the tile's accessible name and tooltip, not on the tile.

Every tile in a grid is as tall as the tallest. A tile taller than its own lines keeps its last two rows (with results
hidden, its date row) at its foot, so they line up across a row of tiles, and the space falls above them. Each extra line (a seat group,
or a free-for-all's third or fourth side) adds 20 px to every tile in the grid ([top-matches.md](top-matches.md)).

## Layout rules

- **Grid**: four columns from 46.125rem (738 px), two under it down to 22.5em (360 px), one under 22.5em. Every cell is the same size.
- **Page edge**: 24 px, 16 px under 64rem, 12 px between 46.125rem and 52rem, 8 px under 24.25em. The grid gap is 12 px,
  8 px under 64rem and 4 px between 46.125rem and 52rem.
- **Two columns on a phone** (24.25em to 46.125rem): page edge 12 px and grid gap 4 px, not 16 and 8. The design measured its
  widest player line with web fonts; the site draws with the visitor's system fonts, where that line (Muse Wonder Full 1.0
  with its effort badge, in Liberation Sans) needs 157.4 px and 16 and 8 px leave 157, so its badge would wrap at 390 px.
  12 and 4 px give it 163.
- **Two columns on the narrowest phones** (22.5em to 24.25em, 360 to 388 px): page edge 8 px and grid gap 4 px, and the
  tile takes the flush list's insets: 2 px on the right and 4 px between a name and its badge, the left inset keeping 8 px
  for the seat rules. At 360 px that line then has 2.6 px to spare in Liberation Sans. One column, under 22.5em, keeps
  its 8 px edge and the flush list below.
- **Four columns from 46.125rem**, not the design's 46rem, for the same reason: at 736 and 737 px four columns leave
  that line too little width in Liberation Sans and its badge wraps, so those two widths keep two columns.
- **Flush list**: under 12em (a phone at 200 % zoom, or with its text doubled) the page edge goes to 0 and the tiles lie
  flush as a list, with a rule between them, so each line keeps the width it needs.
- **Every line on one line**: every line fits on one line from 320 px at the default text size, in Roboto and Liberation Sans.
  The type row, a team's seats included, keeps its one line up to 200 % zoom, with one exception: an unranked team match
  at 200 % zoom on a 320 px phone in Liberation Sans moves its seats ("2 per side"), whole, to the next line. At 200 % zoom on a 320 px phone a team player
  line may move its whole badge onto the next line. Past that, nothing is cut: the badges move to the next line as one unit
  and a long name wraps between words.

The render check (`web/render-check/`) judges the Watch page at 390 and 1280 px in both typefaces against these rules,
with results hidden and shown.
