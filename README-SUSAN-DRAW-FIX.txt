World Squash Masters 2026 - draw-only completed/current match recovery fix

Replace refresh-data.js with the file in this ZIP, commit/push it, then run a normal refresh.

What changed
- NO player-profile crawl was added.
- TournamentSoftware draw numeric sibling slots remain the opponent authority.
- For a concrete two-player sibling pair, the parser no longer requires the separate next-round connector span when the draw itself prints an explicit date and time for that exact sibling pair.
- Bye and Player-vs-TBD progression remains strict and still requires the connector, so this does not loosen opponent guessing.
- Adds refresh diagnostics: "scheduled sibling fallback(s)" and a total count.

Included previous fixes
- 3rd/4th placement draw naming validation fix.
- same-day already-played match preservation protection.

Why
TournamentSoftware can retain the complete draw schedule while a progressed/played match no longer has its output connector rendered in the exact cell expected by the old parser. The old code discarded that match despite the deterministic sibling slots and explicit schedule still being present.
