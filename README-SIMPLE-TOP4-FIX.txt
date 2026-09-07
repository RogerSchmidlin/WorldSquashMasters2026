WORLD SQUASH MASTERS 2026 - SIMPLE TOP 4 RESULTS FIX
=====================================================

Results extraction now follows one deterministic rule only:

1. Select the main draw for each age/gender category.
2. Take the last completed championship match in that main draw.
   Winner = 1st, loser = 2nd.
3. Look for a separate draw for the same category whose title is a
   3rd/4th / 3/4 / playoff draw OR whose TournamentSoftware stage is Extra.
4. Take the last completed match in that secondary draw.
   Winner = 3rd, loser = 4th.
5. If no separate secondary draw exists, take the last explicitly labelled
   3rd/4th / playoff match inside the main draw.
6. The 3rd/4th pair is never allowed to equal the 1st/2nd pair.
7. Results are always rendered in placement order 1, 2, 3, 4.

Removed from Results calculation:
- TournamentSoftware Winners page
- semifinal-loser inference
- bracket-level inference
- page-wide raw-text heuristics
- carrying forward results produced by the previous algorithm

Run:
  npm run refresh:quick

The refresh log prints the exact selected pairs for every category:
  TOP4 Women|35: 1/2=...; 3/4=...
  TOP4 Men|35: 1/2=...; 3/4=...
