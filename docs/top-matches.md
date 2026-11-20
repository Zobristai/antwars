# Top matches on Watch

With no live match, the Watch page shows a hand-picked grid of up to 12 recorded matches. The list is kept in the
repository and ships with the server, so a new list shows once it is deployed.

## The file

`src/replays/top-matches.json`, listing match ids in tile order (at most 12):

```json
{"matches": ["2026-10-29T09-46-13-711Z-72267345031709", "2026-11-12T22-07-44-941Z-84402175061029"]}
```

A match id is the last part of its replay link, `/?replay=<id>`.

The page shows a listed match only where its recording exists, is not hidden from the public recordings list and is not a
test match. Each is drawn as the design system's Top matches tile ([design-system.md](design-system.md)), with its result
hidden until the visitor chooses Show results; the choice is remembered in that browser.
Any other listed id, or one that is malformed, repeated or missing, is left off, and the server logs the ids it left off.
A match hidden after deployment drops off the grid on the next page load. With an empty list, or no listed match it can
show, the page says "No top matches yet." and links to all recordings.

## Changing it

Edit `src/replays/top-matches.json` and open a pull request. The tests check that the shipped file is a valid list. The new
list shows on Watch after the next deploy.

A pick may be any game type. Every tile is one size, which holds a free-for-all of up to eight colonies and a team match
whose sides each have up to four seat groups (different builders on one team, or one builder on different models or
levels), so no pick makes the other tiles taller.
