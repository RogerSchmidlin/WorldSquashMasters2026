WORLD SQUASH MASTERS 2026 — VIC PARK SQUASH EDITION — REFRESHABLE V7

REFRESH
-------
First time in this folder:
  npm install

Then refresh at any time with:
  npm run refresh

The refresher opens your installed Chrome first (Edge/Playwright Chromium are fallbacks).
Leave the browser open until the crawl finishes.

HOW V7 GETS MATCHES
--------------------
V7 no longer relies on the global TournamentSoftware Matches page, because that page was only exposing a small paginated slice to automation.

Instead it:
1. Reads the official TournamentSoftware Players page.
2. Collects the official profile link for each player.
3. Visits every player profile and reads that player's scheduled/played matches.
4. Deduplicates the same match seen from both players.
5. Requires at least 500 unique matches before replacing data.js.
6. Rebuilds index.html and player.html only after validation succeeds.

This makes player schedules the primary source of truth.

VIC PARK PLAYERS
----------------
Edit vic-park-players.txt. Put one player name on each line, for example:
  Roger Schmidlin
  Ashton D'Vaz
  Tanya Chapman

Vic Park Matches only accepts explicit player1/player2 identity matches. It no longer searches raw page text, which prevents unrelated matches being assigned to tracked players.

DIAGNOSTICS
-----------
After every crawl V7 writes:
  refresh-audit.json
  refresh-matches.json

If fewer than 500 unique matches are found, the refresh fails and the existing website data remains untouched.

Run:
  npm run check

to show player count, total matches, Glass Court matches, and each tracked player's linked match count.

GLASS COURT
-----------
Glass Court is built from the same master match list and only includes records whose normalized venue/court explicitly identifies Karrinyup or AGC.


V8 refresh notes
----------------
- Validation is based on crawl coverage, not an incorrect 500-confirmed-match threshold.
- 911 players can produce fewer than 500 currently confirmed player-v-player matches because later rounds are still TBD and first-round byes reduce pairings.
- Player association now uses TournamentSoftware profile-link identity as well as player names.
- A successful refresh rebuilds data.js even when the confirmed unique match count is in the 400s, provided profile coverage is strong.

V9 changes
----------
- A dated/time schedule row on a player's own TournamentSoftware profile is retained even when the opponent cannot yet be canonicalised; it displays as TBD and is enriched when another profile resolves it.
- Opponent player links may use TournamentSoftware's visible name even if it differs from the canonical snapshot.
- Vic Park Matches removes the duplicate tracked-player subline, enlarges the tracked player's name, and puts venue/court at the far right with a venue icon.

VENUE LOGOS (v11)
- WA State Squash Centre / Belmont uses belmont-venue-logo.jpg.
- Squashworld Mirrabooka uses mirrabooka-venue-logo.jpg.
- Karrinyup Shopping Centre / AGC glass court uses karrinyup-glass-court-logo.png.
- These images are also embedded into the generated index.html by app.js, so they survive npm run refresh / build-static.js and work when index.html is opened directly.
- Vic Park date headings show the calendar date only (weekday label removed).
