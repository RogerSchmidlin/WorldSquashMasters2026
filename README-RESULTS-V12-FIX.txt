Results v12 - round-robin live-check fix

Why v11 failed
---------------
The live dry-run correctly refused to write because Men's +85 produced only 1st/2nd.
The old round-robin fallback used every listed draw entrant, so it expected 21 pair
results (7 players). The actual completed draw exposes 15 deterministic pairings,
which is exactly a 6-player active round robin. One listed entrant is not part of
the played round-robin set.

What changed
------------
1. Round-robin draws now capture TournamentSoftware standings-table rows separately.
2. When a W/Won column is available, placements are ranked by wins directly.
3. A zero-played listed entrant is excluded from the active standings.
4. If no standings W column is available, the fallback derives the active player
   set from concrete pairings before calculating expected pair count.
5. Inline draw score rows are reconstructed in player1/player2 orientation so more
   round-robin head-to-head winners can be counted safely.
6. Winners #1 validation now retries/re-navigates up to four times and accumulates
   age-group champion rows across renders. This addresses the thin 17/21 render
   seen in the v11 live-check log.
7. :resultscheck still requires all 84 placement rows and writes nothing.

Commands
--------
npm run test:results
npm run test:results:live
npm run refresh:quick

Expected local regression
-------------------------
Men 85+: Ray Villarroya > Peter Zillmer > Geoffrey Coyne > Barry Gardiner

Do not run refresh:quick unless test:results:live reports 84 placement rows and the
21/21 champion cross-check passes.
