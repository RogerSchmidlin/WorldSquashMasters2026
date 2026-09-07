RESULTS TOP-4 V8 FIX
====================

This version follows the site owner's simple Results rule directly.

For every gender/age group:

1. Identify the MAIN draw from its own draw title only.
2. Select the LAST championship match in that main draw by printed date/time.
3. Only after selecting that exact match, resolve its winner.
   - winner = 1st
   - loser  = 2nd
4. Find the matching secondary draw for the same category where the title is
   3rd/4th / 3/4 / playoff / bronze or TournamentSoftware stage is Extra.
5. Select the LAST match in that secondary draw, then resolve its winner.
   - winner = 3rd
   - loser  = 4th
6. If there is no separate playoff draw, use an explicit 3rd/4th match in the
   main draw. If TournamentSoftware does not label it, find the two semifinal
   losers by following each finalist one match backwards, then use their
   head-to-head as the bronze playoff.

Important corrections:
- The final is selected BEFORE checking whether that particular DOM observation
  contains a winner. This prevents a completed final from being skipped in
  favour of an earlier semifinal.
- Draws are grouped only by their own title, not broad surrounding context.
- 3rd/4th candidates containing either finalist are rejected.
- Previous v7 result rows are not carried forward; the first v8 quick refresh
  rebuilds Results using this rule.

Run:
  npm run refresh:quick

SquashLevels is not contacted.
