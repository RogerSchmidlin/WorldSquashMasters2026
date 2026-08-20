IMPORTANT REFRESH ARCHITECTURE (v2.1)
===================================
Hourly refresh does NOT fetch the Players page. The 911-player directory in data.js is treated as canonical.
`npm run refresh` refreshes only match data from the TournamentSoftware Matches section and updates only data.js.
This means a temporary Players-page rendering/selector change cannot block hourly match refreshes.

WORLD SQUASH MASTERS 2026 - VIC PARK EDITION
============================================

ARCHITECTURE
------------
The website is now deliberately split into three independent parts:

1. DESIGN / WEBSITE
   index.html
   player.html
   styles.css
   app.js
   player-app.js

2. TOURNAMENT DATA
   data.js

   This contains the complete player directory and the master matches array.
   Both Glass Court, Vic Park Matches and individual player schedules are derived
   from this same match array.

3. VIC PARK WATCHLIST
   vic-park-players.js

   Edit this file whenever you want to add/remove club members. No TournamentSoftware
   refresh is needed.

LOCAL DATA REFRESH
------------------
First time in a new folder:

  npm install
  npx playwright install chromium

Then refresh at any time with:

  npm run refresh

The refresher updates ONLY data.js. It does not rebuild or modify the HTML/CSS/JS design.

Check the current dataset with:

  npm run check

VIC PARK PLAYERS
----------------
Edit vic-park-players.js directly, for example:

  window.VIC_PARK_PLAYERS = [
    "Roger Schmidlin",
    "Susan Hillier"
  ];

Save/push that one file. No npm refresh is required.

FAST MATCH REFRESH
------------------
refresh-data.js now uses the TournamentSoftware Matches tab day-by-day rather than
visiting all 911 player profiles. It attempts to load/expand every page for each of
30 Aug through 6 Sep, captures both rendered match rows and TournamentSoftware JSON/XHR
responses, deduplicates them, and writes a single matches[] array.

A safety threshold prevents a tiny partial result from replacing a healthy data.js.
If TournamentSoftware changes its page structure, the workflow fails rather than
publishing an obviously incomplete match list.

GITHUB PAGES / HOURLY REFRESH
-----------------------------
The included file:

  .github/workflows/pages.yml

has two modes:

A) Normal push to main
   - Does NOT fetch TournamentSoftware.
   - Immediately deploys your changed design/watchlist/data files to GitHub Pages.

B) Hourly schedule or manual Run workflow
   - Installs Playwright Chromium.
   - Runs npm run refresh.
   - Updates ONLY data.js.
   - Commits data.js back to the repository if it changed.
   - Deploys the current website to GitHub Pages.

The schedule is 17 minutes past every hour:

  17 * * * *

GITHUB SETUP
------------
1. Copy all files/folders in this package into the root of your GitHub repository.
   Make sure the hidden .github folder is included.

2. Commit and push everything to your main branch.

3. On GitHub open:
      Repository -> Settings -> Pages
   Under Build and deployment, set Source to:
      GitHub Actions

4. Open:
      Repository -> Settings -> Actions -> General
   Under Workflow permissions, make sure the workflow is allowed to write repository
   contents. If your repository/organisation policy permits it, choose:
      Read and write permissions

5. Open the Actions tab. Select:
      Refresh tournament data and deploy Pages
   Choose Run workflow once manually.

6. Watch the log. A successful refresh should print player count, per-day match counts,
   total unique matches and Glass Court matches.

After that GitHub will run it every hour automatically.

IMPORTANT DEPLOYMENT NOTES
--------------------------
- Changing design: push index.html/player.html/styles.css/app.js/player-app.js.
  No data fetch happens on that push.

- Changing Vic Park players: edit/push vic-park-players.js only.
  No data fetch happens on that push.

- Tournament update: scheduled workflow updates data.js automatically.

- Manual local data refresh: upload/push only data.js afterward if you want.

- The public site itself does not run Node.js or Playwright. GitHub Actions performs
  the refresh; GitHub Pages only serves static files.


REFRESH v2.2: Uses the legacy server-rendered /sport/matches.aspx day pages first, with p/ps pagination, and only falls back to the modern Matches UI. This avoids the modern 10-row slice.

RELIABLE HOURLY REFRESH MODE
----------------------------
The hourly refresh intentionally uses the reliable player-profile crawler again.
TournamentSoftware's Matches tab currently exposes only 10 rows per day to automation,
so it is not used as the authoritative source.

The first successful refresh creates player-links.json. Future refreshes reuse that cache,
which avoids re-reading the 911-player directory. The crawler still visits player profiles
because that is the method that previously returned the complete confirmed schedule.

A refresh changes only:
  data.js
  player-links.json (only when the link cache is first built or rebuilt)

It does NOT change:
  index.html
  player.html
  styles.css
  app.js
  player-app.js
  vic-park-players.js

IMPORTANT: WHY THE PROFILE CRAWLER IS BACK
------------------------------------------
The modern TournamentSoftware Matches page currently exposes only about 10 rows per day
to automated browser sessions. Earlier attempts to speed up the refresh by using that page
therefore produced incomplete data (around 70 matches total).

This package deliberately restores the previously successful player-profile crawler. In the
user's earlier run it produced 1,067 raw observations, 426 unique confirmed matches and
22 Glass Court matches from 911 profiles.

The site architecture remains separated:
  - data.js = tournament players + matches
  - vic-park-players.js = editable watchlist
  - HTML/CSS/JS = design

You can redesign the site or change vic-park-players.js without fetching tournament data.
Hourly GitHub refreshes update only data.js (and player-links.json when the cache is created).
