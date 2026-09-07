V16 FINAL RESULTS - NO RECONSTRUCTION
=====================================

The tournament is finished. The Results page no longer attempts to infer the
podium from flattened match rows.

`npm run refresh` now does exactly one job:

1. Read the frozen final V13 top-four placements (21 groups / 84 rows).
2. Look those 84 players up in local players-data.js (or data.js fallback).
3. Copy local flag/country/seed/SquashLevels/club metadata onto each row.
4. Write results-data.js only.

It does NOT read matches-data.js.
It does NOT run Playwright.
It does NOT contact TournamentSoftware.
It does NOT contact SquashLevels.
It does NOT contact SquashScores.

Run once:

  npm run refresh

Expected final lines:

  Final result groups: 21
  Final placement rows: 84
  Wrote only results-data.js.
  No matches parsed. No browser launched. No network request made.
