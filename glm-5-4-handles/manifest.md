# GLM-5.4 house handles: render comparison

Game base `251e0ead88239307cb5aec8777c351c3dbdfa925` and head `983e796a4993d44c470657a58d0e5150b8e151c9`. Screenshots show the rendered Leaderboard, Matches and landing pages; the view is scrolled to the fixture entries, not the top of the page. Each font folder contains `base/` and `head/` captures at 1280 × 800 and 390 × 844 CSS px. Phone captures use 2× device scale. Browser-reported glyph counts and all wrap/cut findings are in the adjacent `measurements.json`.

**Fixtures, not played matches or actual ratings.** The leaderboard fixture contains only `antwars/glm-5-4-low`, `antwars/glm-5-4-high` and `antwars/glm-5-4-max`, in that order, with illustrative ratings 1500, 1499 and 1498; the level and tier fields come from that revision’s house label table. The Recordings fixture prepends two invented 1v1 recordings — low vs high and max vs low — to the repository’s public render snapshot. Otherwise both builds use the same inputs and snapshot clock. No live accounts, launches or matches were used.

**Result:** The base labels the fixture seats “Unlisted model”. The head shows “GLM-5.4” with LOW, HIGH or MAX on three separate leaderboard entries and on the corresponding recording seats. No fixture name or level badge wraps or is clipped. Both Roboto and Liberation Sans were confirmed from Chrome’s drawn fonts.

**Unchanged layout findings:** At 1280 px the landing table heading RATED MATCHES spans two lines in both fonts, on both revisions. No text was cut. On Leaderboard and Matches the hero image is cropped by its container (205 px at 1280, 405 px at 390), identically on both revisions. No other wrap or clipping finding was reported.
