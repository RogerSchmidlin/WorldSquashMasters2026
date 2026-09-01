World Squash Masters 2026 - safe refresh optimization
======================================================

This optimization does NOT remove any data source or matching logic.

What it changes
---------------
The slow Matches-page crawler currently reloads TournamentSoftware once for:
- All venues
- Squashworld Mirrabooka
- Belmont Saints Squash Centre
- Karrinyup Shopping Centre

for every tournament date.

The optimizer keeps all of those fresh page loads and all existing verification,
but prepares the three venue-specific pages at the same time. Once prepared,
they are parsed ONE AT A TIME in the original venue order. This is important:
the parser has shared dedupe / one-player-fragment recovery state, so parsing the
three pages concurrently could change results. This optimizer deliberately does
not do that.

Nothing is removed:
- TournamentSoftware Matches crawl: retained
- all three venue filters: retained
- fresh page per venue: retained
- date verification: retained
- venue verification: retained
- draw-tree crawl: retained
- official match-detail crawl: retained
- score/result overlays: retained
- SquashScores live overlay: retained
- SquashLevels refresh: retained
- validation / safety checks: retained

How to apply
------------
1. Put optimize-refresh.js in the same folder as refresh-data.js.
2. Open a command prompt in that folder.
3. Run:

   node optimize-refresh.js

The script creates:

   refresh-data.before-optimization.js

before changing refresh-data.js, and automatically runs:

   node --check refresh-data.js

If the syntax check fails, it restores the original file automatically.

Runtime tuning
--------------
Default is three parallel venue preparation workers:

   MATCH_VENUE_WORKERS=3

On Windows cmd, to use two:

   set MATCH_VENUE_WORKERS=2
   npm run refresh -- :matches

Use 1 if TournamentSoftware ever starts rate-limiting requests.

Expected effect
---------------
The venue-specific portion was three serial full page reloads per date. Those
three network/render waits now overlap. The exact speedup depends on how slow
TournamentSoftware is at the time, but the Matches-page phase should be
substantially shorter without changing what is crawled or published.
