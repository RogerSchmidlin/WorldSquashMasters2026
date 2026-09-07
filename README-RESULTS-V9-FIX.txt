RESULTS V9 - RIGHT-MOST BRACKET + CHAMPION CROSS-CHECK
======================================================

This fixes the regression where Men's +50 was published as:
  1 Alexander Clark
  2 Zuko Kubukeli
while the championship final is Michael Corren vs Alexander Clark.

Root cause
----------
The previous Results code interpreted "last match" as the chronologically latest
match/date-time observation on a draw page. TournamentSoftware can repeat/move
schedule text and can show consolation/other edges later, so a semifinal or side
match could be selected instead of the championship final.

V9 rule
-------
1. Main draw: select the RIGHT-MOST championship bracket edge structurally.
   On TournamentSoftware this is the level-2 match feeding the Winner level-1
   column. Winner = 1st, loser = 2nd.
2. Matching 3rd/4th / playoff / Stage=Extra draw: select its right-most edge.
   Winner = 3rd, loser = 4th.
3. If no separate playoff draw exists, use the explicitly labelled internal
   playoff. If it has no label, derive the two semifinal losers structurally and
   find their head-to-head bronze match.
4. Do not publish partial groups. All four places must resolve to four distinct
   players.
5. The Winners page is NOT a placement source. During :quick it is read only as
   an independent validation source for champions. Every extracted #1 must match
   the official Winners-page #1 or Results publishing aborts.

Offline tests
-------------
Run:
  npm run test:results

The included tests cover:
- Men's +50 -> Michael Corren, Alexander Clark, Zuko Kubukeli, Adam Dominey
- Women's +35 -> Samantha Foyle, Zoe Petrovansky, Kasey Bonato, Heather Pilley
- Men's +85 -> Barry Gardiner, Geoffrey Coyne, Ray Villarroya, Peter Zillmer

Refresh
-------
  npm run refresh:quick

SquashLevels is not contacted by quick refresh.
