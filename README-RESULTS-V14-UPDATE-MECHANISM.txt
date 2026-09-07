RESULTS V14 - POST-TOURNAMENT UPDATE MECHANISM

Why this change
---------------
The tournament is finished. The repository already contains the complete local
match history, so repeatedly crawling every TournamentSoftware draw is both
unnecessary and a major source of timeouts.

Normal update now
-----------------
`npm run refresh` and `npm run refresh:quick` now do ONLY this:
1. Load the existing local players/matches/results.
2. Open TournamentSoftware Matches for the LAST tournament date (Sun 6 Sep).
3. Parse the All venues view only. No per-venue recrawls.
4. Overlay result/winner/completed-status fields onto EXACT matching local rows.
5. Never add, remove, move or replace fixtures.
6. Preserve the stored Results top-four rows unchanged.
7. Do not crawl draws, players, SquashLevels or SquashScores.

This also keeps working after 6 September: "latest" means the last tournament
date, not today's calendar date.

One-time Results rebuild
------------------------
If the final top-four Results placements ever need to be recalculated from the
TournamentSoftware draw structure, run this manually:

    npm run refresh:results

That command still performs the expensive draw crawl, but it is no longer part
of the normal update path.

Full rebuild remains available as before:

    npm run refresh:full
