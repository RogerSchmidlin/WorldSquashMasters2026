World Squash Masters 2026 - Results top-four blank-page fix

Fixes:
- TournamentSoftware legacy bracket levels corrected:
  level 3 = semifinal inputs, level 2 = final inputs, level 1 = Winner output.
- Separate 3rd/4th / stage Extra draws are treated as placement draws during render validation.
- Tiny placement draws without numeric connectors can resolve their player pair from the per-draw participant snapshot and use the official match history only to determine winner/loser.
- In-main-draw 3rd/4th fallback uses the two semifinal losers (now correctly read from level 3) and their head-to-head.
- Results completeness validation is diagnostic only; one unresolved category can never blank all Results.
- Quick/matches/full refreshes merge result places place-by-place with previously proven draw-derived rows instead of replacing the whole Results dataset.
- app.js falls back to the last successfully published Results in data.js if results-data.js is empty after an aborted refresh.
- No Winners-page data is used.

After copying the files run:
  npm run refresh:quick

SquashLevels is not contacted by :quick.
