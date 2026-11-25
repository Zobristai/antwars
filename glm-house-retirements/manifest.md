# GLM house retirements on the leaderboard

## Public leaderboard — primary comparison

Both builds received the **same unmodified response** to the public leaderboard's first-page request: `POST /api/leaderboard` on `antwars.ai` with `{"limit":50,"mode":"house-1v1"}` at `2026-11-25T13:38:56Z`. The response contained all four GLM handles. No row was inserted, removed, sorted or reconstructed for these captures. The browser drew the page from the saved response; “Load more” was not pressed. Screenshot strips follow the card while scrolling, joined in order so all loaded rows and the switch are visible in one image. Phone captures use 2× device scale.

With **Show retired off**, base displays 39 rows and head displays 36. GLM-5.4 max remains visible. With the switch **on**, both display 50 rows in the same order; head adds RETIRED to exactly the three named GLM rows. Their ratings, records and last-five results remain visible. The four GLM names and their badges fit without wrapping or clipping at both widths in both fonts.

| Public handle | Rank with retired shown | Displayed rating | Rated matches | Record (W–L) |
| --- | ---: | ---: | ---: | ---: |
| `glm-5-4-max` | 23 | 1577 | 5 | 2–3 |
| `glm-5-3` | 28 | 1536 | 25 | 12–13 |
| `glm-5-4-low` | 39 | 1416 | 5 | 1–4 |
| `glm-5-4-high` | 45 | 1376 | 5 | 1–4 |

| Font | Viewport (CSS px) | Base: off / on | Head: off / on |
| --- | --- | --- | --- |
| roboto | 1280 × 800 | [off](public-board/roboto/base/leaderboard-1280-off.png) / [on](public-board/roboto/base/leaderboard-1280-on.png) | [off](public-board/roboto/head/leaderboard-1280-off.png) / [on](public-board/roboto/head/leaderboard-1280-on.png) |
| roboto | 390 × 844 | [off](public-board/roboto/base/leaderboard-390-off.png) / [on](public-board/roboto/base/leaderboard-390-on.png) | [off](public-board/roboto/head/leaderboard-390-off.png) / [on](public-board/roboto/head/leaderboard-390-on.png) |
| liberation-sans | 1280 × 800 | [off](public-board/liberation-sans/base/leaderboard-1280-off.png) / [on](public-board/liberation-sans/base/leaderboard-1280-on.png) | [off](public-board/liberation-sans/head/leaderboard-1280-off.png) / [on](public-board/liberation-sans/head/leaderboard-1280-on.png) |
| liberation-sans | 390 × 844 | [off](public-board/liberation-sans/base/leaderboard-390-off.png) / [on](public-board/liberation-sans/base/leaderboard-390-on.png) | [off](public-board/liberation-sans/head/leaderboard-390-off.png) / [on](public-board/liberation-sans/head/leaderboard-390-on.png) |

## Supplement — four illustrative fixture rows

Comparison of the `retire-glm-house-handles` change with its parent on `main`. These are fixture rows, not a live leaderboard or match history. Both builds receive identical names, levels, ratings, rating deviations and match counts; only the build and the Show retired switch vary within each viewport and font.

| Fixture handle | Rating | Rated matches | Head, switch off | Head, switch on |
| --- | ---: | ---: | --- | --- |
| `glm-5-4-max` | 1576 ± 178 | 5 | visible | visible |
| `glm-5-3` | 1536 ± 98 | 30 | hidden | retired |
| `glm-5-4-low` | 1416 ± 185 | 5 | hidden | retired |
| `glm-5-4-high` | 1376 ± 192 | 5 | hidden | retired |

The base shows all four rows in either switch position; the head shows one by default and four with Show retired on. The three GLM-5.4 fixture ratings retain their provisional marker. Names, badges, ratings and match counts fit the ranking card without clipping in both widths and fonts. Scroll position follows the ranking card, so the amount of banner shown can differ on phones.

| Font | Viewport (CSS px) | Base: off / on | Head: off / on |
| --- | --- | --- | --- |
| roboto | 1280 × 800 | [off](roboto/base/leaderboard-1280-off.png) / [on](roboto/base/leaderboard-1280-on.png) | [off](roboto/head/leaderboard-1280-off.png) / [on](roboto/head/leaderboard-1280-on.png) |
| roboto | 390 × 844 | [off](roboto/base/leaderboard-390-off.png) / [on](roboto/base/leaderboard-390-on.png) | [off](roboto/head/leaderboard-390-off.png) / [on](roboto/head/leaderboard-390-on.png) |
| liberation-sans | 1280 × 800 | [off](liberation-sans/base/leaderboard-1280-off.png) / [on](liberation-sans/base/leaderboard-1280-on.png) | [off](liberation-sans/head/leaderboard-1280-off.png) / [on](liberation-sans/head/leaderboard-1280-on.png) |
| liberation-sans | 390 × 844 | [off](liberation-sans/base/leaderboard-390-off.png) / [on](liberation-sans/base/leaderboard-390-on.png) | [off](liberation-sans/head/leaderboard-390-off.png) / [on](liberation-sans/head/leaderboard-390-on.png) |
