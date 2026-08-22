Vic Park & Friends speed fix

Replace these files in the repository:
- app.js
- refresh-data.js
- split-data.js
- .github/workflows/pages.yml

Then run once locally:
  npm run split-data

This generates vicpark-data.js from the existing data.js and vic-park-players.js.
Commit vicpark-data.js as well. Future refreshes regenerate it automatically.

The Vic Park page now loads only the tracked players, their opponents, and their matches instead of loading the full player and match datasets. The rendered page is cached for subsequent tab clicks.
