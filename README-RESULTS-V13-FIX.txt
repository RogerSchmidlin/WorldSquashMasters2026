RESULTS V13 - DEDICATED PLAYOFF EDGE FIX

Problem found by live :resultscheck:
- 21/21 champions were correct.
- Men +85 round-robin standings were resolved.
- Women +70 and Women +75 still lacked 3rd/4th.
- Their dedicated 3rd/4th draw pages can contain two tiny placement edges (4 players / 6 boxes / 2 matches).
- v12 treated the playoff page too much like a chronological list, so it could fail to choose the actual bronze final.

V13 rule:
1. Main elimination draw: championship edge feeding Winner output -> 1st/2nd, guarded by official #1.
2. Dedicated 3rd/4th / Extra draw: choose the right-most PRIMARY placement edge.
   TournamentSoftware's first placement output is normally slot 1001 (inputs 2001/2002).
   This is preferred over a later date/time or later DOM order.
3. The selected 3rd/4th edge must not contain either championship finalist.
4. If no separate playoff draw exists, use the existing in-main-draw bronze fallback.
5. Round robin remains standings-based.
6. :resultscheck still requires all 21 groups, four distinct players each, 84 rows total.
7. Winners page remains a #1 validation guard only.

Offline regression includes Women +70 and Women +75 playoff pages with TWO placement edges, where the wrong edge appears later. Both must select the structural 1001 bronze final.
