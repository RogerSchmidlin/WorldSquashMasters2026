WORLD SQUASH MASTERS 2026 - V18 LOCAL RESULTS RELATIONSHIP ALGORITHM

Normal Results build is 100% local. No browser, scraping or network calls.

Algorithm for knockout categories:
1. Find the completed main-draw semifinals.
2. Take the two semifinal winners.
3. Find their later head-to-head. Winner = 1st, loser = 2nd.
4. Take the two semifinal losers.
5. Find their later head-to-head. Winner = 3rd, loser = 4th.
6. If the semifinal losers never play each other later, publish Bye / Bye for 3rd / 4th.

If there are no elimination-round labels and the local completed pairings form a complete all-play-all set, standings are calculated as a round robin (Men 85+).

Commands:
  npm run refresh       Build only results-data.js from local matches-data.js / data.js
  npm run test:results  Run regression tests for Women 70+, Men 80+, Men 85+

The Results page loads only the compact results-data.js. Bye rows do not create fake player links or medals.
