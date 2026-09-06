World Squash Masters 2026 - venue name authority fix

Problem fixed:
- Correct M/B/G venue badge but wrong venue text on today's matches.
- Courts page grouped today's matches under the wrong venue.
- Court numbers were already correct and are not re-derived/changed by the frontend fix.

Files:
1. app.js
   - Makes one canonical venue resolver authoritative for venue badge text, displayed venue name, and Courts grouping.
   - M = Squashworld Mirrabooka
   - B = Belmont Saints Squash Centre
   - G = Karrinyup Shopping Centre
   - Keeps the existing court number.

2. refresh-data.js
   - Restores the already-existing exact verified draw-location overlay after schedule merge/dedup.
   - Uses exact date/time/player pair and rejects conflicting draw locations.
   - Prevents stale venue names from surviving a later merge.
   - Includes the previous draw completeness, today preservation, 3rd/4th validation, and SquashLevels override changes.

3. squashlevels-overrides.json
   - Keeps the two Julian-opponent SquashLevels overrides.

4. index.html
   - Only change is the app.js cache-busting revision string.

Replace these files, then run the normal refresh so the corrected venue names are written into the data files.
