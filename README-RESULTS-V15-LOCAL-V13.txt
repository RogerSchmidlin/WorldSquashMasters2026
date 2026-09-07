RESULTS V15 - LOCAL DATA, ORIGINAL V13 RESULT ALGORITHM

This patch does NOT change the existing Results page layout or filtering.

It fixes the previous V14 mistake where the static builder chose an old result array based on metadata richness.

The one-time local builder now reuses the exact V13 selector from refresh-data.js:
1. Main championship final -> 1st and 2nd.
2. Dedicated 3rd/4th / Extra draw -> structural primary placement edge (1001 fed by 2001/2002) -> 3rd and 4th.
3. Reject any bronze pair that overlaps the championship finalists.
4. If no separate playoff exists, use the explicit/internal bronze fallback from V13.
5. Round-robin categories use standings calculated from the complete local head-to-head set.
6. The 21 final official champions from the last successful Winners validation are stored only as a #1 guard/disambiguator. They do not supply places 2-4.
7. A complete category is replaced atomically; no mixing of halves from different algorithms.
8. All 21 categories must have four distinct players or results-data.js is NOT overwritten.

DATA SOURCE
- players-data.js / data.js
- matches-data.js / data.js
- existing complete V13 result categories only as fallback

NO NETWORK
- no Playwright browser
- no TournamentSoftware request
- no Winners-page request
- no SquashLevels
- no SquashScores

RUN ONCE
  npm run refresh

This writes only results-data.js. The Results page then loads that compact static file.
