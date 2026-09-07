World Squash Masters 2026 - Results V20

Normal update remains fully local:
  npm run refresh

V20 fixes championship semifinal selection by using progression/loss history:
- a true championship semifinalist must be undefeated before that semifinal;
- consolation/placement semifinal chains are therefore rejected even when their local event/round text is ambiguous;
- the two semifinal winners define the final pair;
- their later head-to-head defines 1st/2nd;
- the two semifinal losers define the possible bronze pair;
- if those losers do not meet later, places 3/4 are Bye/Bye.

Non-knockout fallback:
- complete active-player round robin -> calculate standings from local results;
- if the flattened local match rows are insufficient (e.g. Women's 80+), use the already-local stored standings/result snapshot rather than inventing a bracket or contacting the web.

No Playwright, browser, TournamentSoftware, SquashScores or SquashLevels request is made by npm run refresh.
Only results-data.js is written.

Regression:
  npm run test:results

Checks:
- side/consolation semifinal chain is rejected by prior-loss history;
- Women 70+: Pauline Douglas, Gaye Mitchell, Bye, Bye;
- Men 80+: Howard Armitage, Michael Millington, Robert Smith, Alastair James;
- Men 85+: active-player round-robin standings;
- Women 80+: local stored standings fallback.
