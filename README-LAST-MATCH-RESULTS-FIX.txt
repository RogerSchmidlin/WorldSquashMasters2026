WORLD SQUASH MASTERS 2026 - RESULTS LAST-MATCH FIX
==================================================

This patch replaces the previous top-four heuristic with the simpler tournament rule:

1st / 2nd
---------
- Select the championship MAIN draw for each gender/age category.
- Ignore Plate, Consolation, Position, Bronze and playoff rows.
- Take the LAST completed championship match in that main draw.
- Winner = 1st, loser = 2nd.

3rd / 4th
---------
- Look for a sibling draw of the same gender/age whose title identifies 3rd/4th/playoff,
  or whose TournamentSoftware stage is Extra.
- Take the LAST completed match in that secondary draw.
- Winner = 3rd, loser = 4th.
- If no secondary draw exists, fall back to the 3rd/4th playoff inside the main draw.

Important fixes
---------------
- Main draw selection no longer uses broad row context that can accidentally include an Extra label.
- Consolation/Plate finals on a main draw page cannot be mistaken for the championship final.
- Men's 85+ uses its main draw last completed championship match for places 1 and 2.
- Old v5 result rows are retired and will not be carried forward after the next quick refresh.
- Result groups are merged atomically: a complete fresh top four replaces the whole category.
- Refresh output logs the chosen 1/2 and 3/4 pair for every category.

Run:
  npm run refresh:quick

SquashLevels is not contacted.
