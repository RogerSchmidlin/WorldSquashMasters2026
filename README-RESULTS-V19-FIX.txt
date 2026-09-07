WORLD SQUASH MASTERS 2026 - V19 STAGE-AWARE LOCAL RESULTS

Normal Results build is 100% local. No browser, scraping or network calls.

Knockout algorithm:
1. Find championship semifinals only. Stage classification uses event + drawName + round.
2. Ignore Consolation, Plate, placement, bronze and 3rd/4th branches even if their round says Semi final.
3. Take the two championship semifinal winners.
4. Find their later head-to-head: winner = 1st, loser = 2nd.
5. Take the two championship semifinal losers.
6. Find their later head-to-head: winner = 3rd, loser = 4th.
7. If those losers never play later, publish Bye / Bye.

Round robin:
- Used only when no championship-semifinal relationship resolves the group.
- Finds the largest complete active-player all-play-all set.
- Withdrawn/Bye entrants do not invalidate the standings.

Commands:
  npm run refresh       Build only results-data.js from local matches-data.js / data.js
  npm run test:results  Regression test for stage filtering, Women 70+, Men 80+ and active Men 85+

No TournamentSoftware request is made by npm run refresh.
