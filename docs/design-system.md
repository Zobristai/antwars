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

1. the game type, and its size: "1v1", a team match's seats in words ("2 per side"), a free-for-all's colonies as sides
   ("4 sides");
2. the players (below);
3. how the match ended, in the site's own words without the tie-break step it was decided on (" · decided on …"),
   and on a free-for-all also without the leading "Last colony standing"; the tile's accessible name keeps the full words;
4. the date, with the match's length on the right.

### One size for every game type

Every tile is one size, whatever its game type, so the grid holds any pick without growing. The players stand in one block
four player lines tall (80 px at the default text size) with two columns, enough for a free-for-all of up to eight colonies
or a team match of two sides of up to four seat groups each:

- **Free-for-all:** one line per colony, filled across then down in colony order, so a four-colony match's lines stand
  where its colonies start on the map (top left, top right, bottom left, bottom right). Only the winner's line is marked,
  its band filling its own column; hidden and shown use the same order.
- **Team match:** the two sides one under the other, the winner's first, each a full-width band. A side whose seats are
  alike is one full-width line. A side whose seats differ is one block, its band over all its lines; its seat groups fill
  the two columns across, then down, and a last group alone on its row takes the whole row. In the right-hand column a
  line's seat marks stand inside the tile, 4 px before its name.
- **1v1:** its two lines across the full width.

The block is centred between the game type and the foot rows, so a tile with fewer lines has its spare height split
above and below them (a 1v1: 20 px each), and the game type and foot rows stand at the same y on every tile. A line keeps
the tile's 8 px left inset and 4 px on its right, so text in the two columns stands 12 px apart. A line too long for its
column never wraps: it shortens its model name first, then its builder's name, each with an ellipsis; its full text stays
in the name's title and the tile's title and accessible name. With the current picks this happens only at 320 px. A badge
longer than eight characters shows its first eight and an ellipsis, its full text in its title.

Under 18em of viewport width (a 320 or 390 px phone with its text doubled, or a phone at 200 % zoom) two columns do not
fit: the lines stack one per line in a block eight player lines tall, still one size for every tile. From 320 CSS px a
stacked line shortens rather than wraps; below that (200 % zoom) it may wrap between items and every tile grows with the
tallest.

### Results hidden

By default the tiles hide every result. A hidden tile shows only its game type, its sides in colony order (the order
Matches lists colonies in) and its date, at its foot: no winner band, no colony colour, seat marks grey on every side, no
"how it ended" row and no length (a length equal to the time limit would say the match went to time). The result is not
drawn and then hidden: the tile's markup and its accessible name carry none of it. The accessible name names the sides
joined by "versus" (a free-for-all lists its colonies), then the type and the date. Hidden tiles are 146 px tall at the
default text size; shown, 162 px.

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

Every tile in a grid is as tall as the tallest, and at any one text size every tile is the same height.

## Layout rules

- **Grid**: two tiles across from 46.125rem (738 px), one under it. Every cell is the same size. Three across does not fit
  at 1280 px: each player column would be about 145 px, and the widest line needs 152.2 px.
- **Page edge**: 24 px, 16 px under 64rem, 12 px between 46.125rem and 52rem and between 24.25em and 46.125rem, 8 px under
  24.25em. The grid gap is 12 px, 8 px under 64rem, 4 px between 46.125rem and 52rem and between 22.5em and 46.125rem,
  except that one tile across on a page wider than 738 px (only with enlarged text) keeps 8 px.
- **Tile width**: 450 px at 1280 px, 366 px at 390 px, 304 px at 320 px.
- **Flush list**: under 12em (a phone at 200 % zoom, or with its text doubled) the page edge goes to 0 and the tiles lie
  flush as a list, with a rule between them, so each line keeps the width it needs.
- **Every line on one line**: at the default and doubled text sizes, from 320 px, every row of every tile, the title, the
  state line and the button keep one line, in Roboto and Liberation Sans; a player line too long for its space shortens as
  above. Player names never shorten at 360 px and wider at the default text size. At 200 % zoom on a 320 px phone a badge,
  a team's seats ("2 per side") or a free-for-all's sides ("8 sides") may move whole to the next line, and the state line may
  wrap between words.

The render check (`web/render-check/`) judges the Watch page at 390 and 1280 px in both typefaces against these rules,
with results hidden and shown.
