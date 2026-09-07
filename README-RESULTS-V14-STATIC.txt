WORLD SQUASH MASTERS 2026 - V14 STATIC RESULTS

The tournament is finished. Results no longer require scraping.

Normal command:
  npm run refresh

This now runs build-results-local.js only. It reads the already stored local
results from results-data.js / data.js, enriches them from players-data.js,
and writes one compact final results-data.js file.

It does NOT:
- launch Playwright or Chrome
- contact TournamentSoftware
- crawl draws
- contact SquashLevels
- contact SquashScores
- rebuild matches or players

The existing Results page loads results-data.js directly. It no longer loads
players-data.js first, and the final results file uses a cacheable fixed URL.

The old online scraper is retained only as an explicit manual command:
  npm run refresh:online

You should not need that for the finished tournament.
