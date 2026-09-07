World Squash Masters 2026 - Results selector v10

Why v9 was wrong
---------------
Some main draw pages, especially Men's 85+, contain more than one placement tree.
Several rows can therefore look structurally like a final. The v9 regression fixture
incorrectly declared Barry Gardiner vs Geoffrey Coyne as the Men's 85+ championship
final, even though the official champion is Ray Villarroya.

V10 rule
--------
1. Read the main draw for each age/gender category.
2. Read the official Winners page ONLY for the #1 player as a validation/disambiguation guard.
3. Inside the main draw, locate the completed championship match won by that official #1.
4. The opponent in that exact match is 2nd.
5. If a matching 3rd/4th, 3/4, playoff or Stage=Extra draw exists, use its final for 3rd/4th.
6. Otherwise trace the two feeder matches into the selected championship final; their losers
   are the bronze finalists. Their head-to-head in the same main draw gives 3rd/4th.
7. The Winners page is NOT used to source 2nd, 3rd or 4th.
8. Publishing still aborts if the calculated champions do not match the official #1 list or
   if a complete four distinct placements cannot be produced for every category.

Tests
-----
Offline selector regression test:
  npm run test:results

Live dry-run against TournamentSoftware, writes no files:
  npm run test:results:live

Actual quick refresh after the live check passes:
  npm run refresh:quick

The offline test explicitly includes:
- Men's 50+: Michael Corren as champion
- Women's 35+: Samantha Foyle as champion
- Men's 85+: Ray Villarroya as champion, with a decoy placement final in the same draw
