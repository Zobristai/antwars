# /rules render evidence: Accounts and keys section (PR #169)

- **Base:** 4994cfc5770b1613e546b9417d691106f6969271 (main, the PR base).
- **Head:** 9a707e1674a141361493e0e64ea14a83cc0f28b8 (the PR head).
- **Page:** /rules as a default server shows it between matches, at 1280x800 (desktop) and 390x844 (phone: mobile viewport, touch), in Roboto and in Liberation Sans.
- Rendered 2026-11-18T02:19:15Z to 2026-11-18T02:21:06Z. This states what was rendered and measured. It gives no verdict on the PR.

## Snapshot

`snapshot/rules-config.json`, SHA-256 b9cd3df115b3d0d865e3152f6fa494f22eebf0f5068d5514bbec05652b80dd99, is `newMatchConfig(rulesConfig("redesign"))`: the config a default server shows on /rules between matches. Both builds render from this one file. Each tree wrote the same JSON byte for byte, and a JSON round trip renders the same page.

## Method

- **Builds:** for each commit, a `git archive` with the same installed dependencies (package-lock.json is identical at both commits), then `npx vite build --config web/vite.config.ts`.
- **Rendering:** each tree renders through its own `web/capture/browser.ts`, so each build draws its own `renderRules` and its own built Rules client. The server page is answered with `renderRules(config, { undrawn: true, assets })`, as `src/spectator.ts` serves it before a map is drawn. The browser is Chrome for Testing 149, offline. There were no failed requests, page errors or console errors.
- **Typefaces:** fontconfig resolves `system-ui` and `sans-serif` to the typeface of the set. Roboto Regular, Medium and Bold come from the Roboto TTFs; Liberation Sans is the system package.
- **Images per set** (`<typeface>/<base|head>-<sha8>-<typeface>-rules-<width>`):
  - `.png`: the first screen.
  - `-scroll-NN.png`: the whole page, as normal-height frames of the scrolling container. Each frame overlaps the previous one by 100 px, and the last reaches the bottom.
  - `-section-accounts-and-keys.png` (head only) and `-section-lobbies.png`: each section cut out whole, using a 3,000 px viewport for the cut only.
- **Measured per set:** the browser’s own font report for every visible text part (`CSS.getPlatformFontsForNode`). Every heading, index link, button, chip, badge, label, one-line item and one-line state line is checked for wrapping, cuts and overlaps. Its spare width is (available − needed) / available, where available is found by widening an invisible spacer until the item or its line changes. Run records are in `<typeface>/runs-*.json`, and every item is listed in `INVENTORY.md`. `SHA256SUMS` covers every file.

## Typeface the browser reported

| Set | Width | Families reported (glyphs) | Text parts | Parts in another family |
|---|---|---|---|---|
| base 4994cfc5, Roboto | 1280 | Roboto (27107), Roboto Medium (18) | 102 | 0 |
| base 4994cfc5, Roboto | 390 | Roboto (26859), Roboto Medium (18) | 102 | 0 |
| head 9a707e16, Roboto | 1280 | Roboto (28432), Roboto Medium (18) | 110 | 0 |
| head 9a707e16, Roboto | 390 | Roboto (28170), Roboto Medium (18) | 110 | 0 |
| base 4994cfc5, Liberation Sans | 1280 | Liberation Sans (27192) | 102 | 0 |
| base 4994cfc5, Liberation Sans | 390 | Liberation Sans (26932) | 102 | 0 |
| head 9a707e16, Liberation Sans | 1280 | Liberation Sans (28519) | 110 | 0 |
| head 9a707e16, Liberation Sans | 390 | Liberation Sans (28245) | 110 | 0 |

Every set is in the typeface it is named for. Roboto Medium is the top bar’s links.

## Tight-fit inventory: items under 8% spare

**None**, at base or head, in either typeface, at either width. No item wraps, is cut or overlaps another, and no short text runs onto a second line. The full list is in `INVENTORY.md`.

| Set | Width | Items | Under 8% spare | Wraps | Short-text wraps | Cuts | Overlaps | Tightest three: text, needed / available px, spare |
|---|---|---|---|---|---|---|---|---|
| base 4994cfc5, Roboto | 1280 | 39 | 0 | 0 | 0 | 0 | 0 | index link "Model Index matches" 133.8 / 172, 22.2%; index link "Thoughts and marks" 128.3 / 171.9, 25.4%; index link "Food and hatching" 115.6 / 172, 32.8% |
| base 4994cfc5, Roboto | 390 | 39 | 0 | 0 | 0 | 0 | 0 | index link "Model Index matches" 133.8 / 171, 21.7%; index link "Thoughts and marks" 128.3 / 170.9, 24.9%; index link "Food and hatching" 115.6 / 170.7, 32.3% |
| head 9a707e16, Roboto | 1280 | 41 | 0 | 0 | 0 | 0 | 0 | index link "Model Index matches" 133.8 / 172, 22.2%; index link "Thoughts and marks" 128.3 / 171.9, 25.4%; index link "Accounts and keys" 117.4 / 171.9, 31.7% |
| head 9a707e16, Roboto | 390 | 41 | 0 | 0 | 0 | 0 | 0 | index link "Model Index matches" 135 / 160.9, 16.1%; index link "Thoughts and marks" 128.3 / 170.9, 24.9%; index link "Accounts and keys" 117.4 / 171, 31.4% |
| base 4994cfc5, Liberation Sans | 1280 | 39 | 0 | 0 | 0 | 0 | 0 | index link "Model Index matches" 133.1 / 171.8, 22.5%; index link "Thoughts and marks" 127.6 / 172, 25.8%; index link "Food and hatching" 116 / 171.7, 32.5% |
| base 4994cfc5, Liberation Sans | 390 | 39 | 0 | 0 | 0 | 0 | 0 | index link "Model Index matches" 133.1 / 171, 22.2%; index link "Thoughts and marks" 127.6 / 171, 25.4%; index link "Food and hatching" 116 / 170.8, 32.1% |
| head 9a707e16, Liberation Sans | 1280 | 41 | 0 | 0 | 0 | 0 | 0 | index link "Model Index matches" 133.1 / 171.8, 22.5%; index link "Thoughts and marks" 127.6 / 172, 25.8%; index link "Accounts and keys" 117.5 / 171.7, 31.6% |
| head 9a707e16, Liberation Sans | 390 | 41 | 0 | 0 | 0 | 0 | 0 | index link "Model Index matches" 133.1 / 171, 22.2%; index link "Thoughts and marks" 127.6 / 171, 25.4%; index link "Accounts and keys" 117.5 / 170.8, 31.2% |

## The new section at head

| Set | Width | Index link | Section heading |
|---|---|---|---|
| head 9a707e16, Roboto | 1280 | 1 line, 117.4 / 171.9 px, 31.7% | 1 line, 163 / 326.1 px, 50% or more |
| head 9a707e16, Roboto | 390 | 1 line, 117.4 / 171 px, 31.4% | 1 line, 152.2 / 304.3 px, 50% or more |
| head 9a707e16, Liberation Sans | 1280 | 1 line, 117.5 / 171.7 px, 31.6% | 1 line, 176.3 / 352.7 px, 50% or more |
| head 9a707e16, Liberation Sans | 390 | 1 line, 117.5 / 170.8 px, 31.2% | 1 line, 164.6 / 324 px, 49.2% |

## Whole-page runs

| Set | Width | Scroll frames | Reached bottom | Frames contiguous | Section cut whole | Page errors | Failed requests |
|---|---|---|---|---|---|---|---|
| base 4994cfc5, Roboto | 1280 | 15 | true | true | Lobbies: true | 0 | 0 |
| base 4994cfc5, Roboto | 390 | 22 | true | true | Lobbies: true | 0 | 0 |
| head 9a707e16, Roboto | 1280 | 16 | true | true | Accounts and keys: true; Lobbies: true | 0 | 0 |
| head 9a707e16, Roboto | 390 | 24 | true | true | Accounts and keys: true; Lobbies: true | 0 | 0 |
| base 4994cfc5, Liberation Sans | 1280 | 15 | true | true | Lobbies: true | 0 | 0 |
| base 4994cfc5, Liberation Sans | 390 | 23 | true | true | Lobbies: true | 0 | 0 |
| head 9a707e16, Liberation Sans | 1280 | 16 | true | true | Accounts and keys: true; Lobbies: true | 0 | 0 |
| head 9a707e16, Liberation Sans | 390 | 24 | true | true | Accounts and keys: true; Lobbies: true | 0 | 0 |
