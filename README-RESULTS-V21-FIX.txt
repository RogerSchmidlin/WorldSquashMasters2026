V21 - refresh hang fix

The V20 local Results builder could hang in the round-robin fallback because it searched all player combinations to find a complete active-player clique. That is exponential.

V21 changes only the local Results builder:
- removes the exhaustive combination search
- uses bounded graph/degree/neighbour pruning instead
- adds immediate startup output and a Processing <group> line before each category
- keeps the undefeated championship semifinal -> final relationship algorithm
- keeps stored local standings as a fallback where flattened match rows cannot reconstruct a non-knockout group

No scraping, browser, or network access is used by npm run refresh.

Run:
  npm run refresh

Optional regression:
  npm run test:results
