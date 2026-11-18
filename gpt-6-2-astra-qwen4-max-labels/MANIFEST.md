# Renders: GPT-6.2 Astra and Qwen4 Max labels, qwen3-8-max retired

Base: main `4994cfc5`. Head: `e4728c55`. Leaderboard, Antwars Model Index 1v1 board, at 1280x900 and 390x844 (phone emulation, touch).
Browser: Chromium headless shell, SwiftShader. Same data replayed to both builds.

**Data.** Rows 1-47 are one real read of the public leaderboard (house-1v1) taken 2026-11-18T02:41:12Z, replayed identically to base and head.
Rows 48-55 are **fixtures**: the eight new handles have no rated matches yet, so each is appended with a placeholder rating (1500 down to 1493, ±350, 1 rated match) and the level and tier the head server reports for it.

**Files.** `*-top.png`: first screen. `*-retired-row.png`: qwen3-8-max (rank 35, rating 1327) with two rows either side. `*-fixture-rows.png`: the eight fixture rows with one row above.

**Result.** Head shows `GPT-6.2 Astra` with LOW, MEDIUM, HIGH, XHIGH or MAX and FAST, and `Qwen4 Max` with LOW, HIGH or XHIGH. Base shows `Unlisted model` with no badge on the same rows. qwen3-8-max keeps its row, rank and rating; head adds the RETIRED badge after XHIGH. No page errors in either build.

| Build | Viewport | File | SHA-256 |
|---|---|---|---|
| base | 1280x900 | base-leaderboard-1280-top.png | `cf9c03cfd14337a9394f1c17a8ed80b87dc8542519a45948d1d337779416c343` |
| base | 1280x900 | base-leaderboard-1280-retired-row.png | `5ad173c145982e66794b69e48e6678c7b2943eca7c58cebbe4dd87f02391b981` |
| base | 1280x900 | base-leaderboard-1280-fixture-rows.png | `1a84d932b35f2de7fb0ac5453c8b946c5a91840e7c2a25bc9dad84d514d5012d` |
| base | 390x844 | base-leaderboard-390-top.png | `a5ed51196b875785e454363ccf45fe016bbda8809bdceeadf217d5e563a8e0a6` |
| base | 390x844 | base-leaderboard-390-retired-row.png | `0accbf3242ee4b66716895b1046c3a6ecd9bd8caa21b136475d023d3bae3c328` |
| base | 390x844 | base-leaderboard-390-fixture-rows.png | `b605d9bcc68a5ee6e4e145b9748350bd76d3fb635a10d466a21183b38644781d` |
| head | 1280x900 | head-leaderboard-1280-top.png | `cf9c03cfd14337a9394f1c17a8ed80b87dc8542519a45948d1d337779416c343` |
| head | 1280x900 | head-leaderboard-1280-retired-row.png | `5e763aad92320934e3a027bae21b69f05abaf05420306cc25663cb73bf2eff33` |
| head | 1280x900 | head-leaderboard-1280-fixture-rows.png | `62bde1e2688c6b9b77b9c0993efcc27334e3ca41b98dd02321bec3afb85a9d0a` |
| head | 390x844 | head-leaderboard-390-top.png | `a5ed51196b875785e454363ccf45fe016bbda8809bdceeadf217d5e563a8e0a6` |
| head | 390x844 | head-leaderboard-390-retired-row.png | `532fc88392031cdc52eea2f13b561bca8e6fea4235417b7567bf25089a806c9f` |
| head | 390x844 | head-leaderboard-390-fixture-rows.png | `3cd23602cd239504c109d2a5ca34f633b32916d9c8ed88607d58e3037f5ecfdd` |

## Rows of interest: each row's text as drawn, cells run together

**base 1280x900** (55 rows)

- 35Qwen3.8 Maxxhigh1327 ± 106207–13
- 48Unlisted model1500 ± 350, provisional1
- 49Unlisted model1499 ± 350, provisional1
- 50Unlisted model1498 ± 350, provisional1
- 51Unlisted model1497 ± 350, provisional1
- 52Unlisted model1496 ± 350, provisional1
- 53Unlisted model1495 ± 350, provisional1
- 54Unlisted model1494 ± 350, provisional1
- 55Unlisted model1493 ± 350, provisional1

**base 390x844** (55 rows)

- Rank 35Qwen3.8 MaxxhighRating 1327 ± 106Rated matches 20Record 7–13Last 5
- Rank 48Unlisted modelRating 1500 ± 350, provisionalRated matches 1
- Rank 49Unlisted modelRating 1499 ± 350, provisionalRated matches 1
- Rank 50Unlisted modelRating 1498 ± 350, provisionalRated matches 1
- Rank 51Unlisted modelRating 1497 ± 350, provisionalRated matches 1
- Rank 52Unlisted modelRating 1496 ± 350, provisionalRated matches 1
- Rank 53Unlisted modelRating 1495 ± 350, provisionalRated matches 1
- Rank 54Unlisted modelRating 1494 ± 350, provisionalRated matches 1
- Rank 55Unlisted modelRating 1493 ± 350, provisionalRated matches 1

**head 1280x900** (55 rows)

- 35Qwen3.8 Maxxhighretired1327 ± 106207–13
- 48GPT-6.2 AstralowFast1500 ± 350, provisional1
- 49GPT-6.2 AstramediumFast1499 ± 350, provisional1
- 50GPT-6.2 AstrahighFast1498 ± 350, provisional1
- 51GPT-6.2 AstraxhighFast1497 ± 350, provisional1
- 52GPT-6.2 AstramaxFast1496 ± 350, provisional1
- 53Qwen4 Maxlow1495 ± 350, provisional1
- 54Qwen4 Maxhigh1494 ± 350, provisional1
- 55Qwen4 Maxxhigh1493 ± 350, provisional1

**head 390x844** (55 rows)

- Rank 35Qwen3.8 MaxxhighretiredRating 1327 ± 106Rated matches 20Record 7–13Last 5
- Rank 48GPT-6.2 AstralowFastRating 1500 ± 350, provisionalRated matches 1
- Rank 49GPT-6.2 AstramediumFastRating 1499 ± 350, provisionalRated matches 1
- Rank 50GPT-6.2 AstrahighFastRating 1498 ± 350, provisionalRated matches 1
- Rank 51GPT-6.2 AstraxhighFastRating 1497 ± 350, provisionalRated matches 1
- Rank 52GPT-6.2 AstramaxFastRating 1496 ± 350, provisionalRated matches 1
- Rank 53Qwen4 MaxlowRating 1495 ± 350, provisionalRated matches 1
- Rank 54Qwen4 MaxhighRating 1494 ± 350, provisionalRated matches 1
- Rank 55Qwen4 MaxxhighRating 1493 ± 350, provisionalRated matches 1


## How these were made

`render.mjs` serves one built web bundle, answers the Leaderboard's one read with the saved public page plus the eight fixture rows, refuses every other origin, and takes the three screenshots at each width. Base was built from main `4994cfc5`, head from `e4728c55`, with `vite build --config web/vite.config.ts`.
