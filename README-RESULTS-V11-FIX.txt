RESULTS V11 - ROUND ROBIN + STRICT 84/84 VALIDATION
==================================================

Top-four rules:

1. Elimination draws
   - 1st/2nd come from the championship final in the main draw.
   - The official Winners page is used ONLY to validate/disambiguate the champion (#1).
   - 3rd/4th come from the matching 3rd/4th / playoff / Stage=Extra draw.
   - If the secondary draw renders only two player boxes, that exact pair is resolved from the official match history.
   - If no separate playoff exists, the explicit/internal 3rd/4th match in the main draw is used.

2. Round robin fallback
   - If no separate or internal playoff can be found, the draw is tested as a round robin.
   - Every entrant must have a decided head-to-head against every other entrant.
   - Standings are sorted by match wins (most wins first).
   - Ties use head-to-head mini-league wins, then game differential, then point differential.
   - This handles Men's +85, where there is no championship/bronze playoff structure.

3. Validation
   - npm run test:results runs offline regression tests.
   - npm run test:results:live is read-only and now FAILS unless all 21 groups have 4 distinct places = 84 rows.
   - All 21 calculated champions must match the official Winners-page #1 entries.
   - npm run refresh:quick publishes only after the same complete top-four validation passes.

No SquashLevels requests are made by :quick or :resultscheck.
