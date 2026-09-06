World Squash Masters 2026 - draw location integrity fix

Root cause fixed:
The connector-less legacy sibling fallback introduced to recover progressed draw matches
was allowed to trust venue/court text from the bracket cells between the two sibling slots.
Those cells can contain the neighbouring edge's location after the draw progresses.
This produced correct players/date/time and often the correct court token, but the wrong venue.

Fix:
- sibling slot fallback still proves opponents and date/time
- it no longer contributes venue/court/result without the exact connector
- downstream location recovery cannot parse location back from its raw bracket context
- current/future corrupted prior location is not carried forward for such rows
- exact official draw/match evidence must supply venue/court, otherwise the existing safety
  validation refuses publication rather than publishing a wrong location
- removed the UI label-forcing workaround; app.js again displays the actual match venue data
- court parsing itself is unchanged

Includes the existing SquashLevels opponent overrides and previous refresh fixes.

Install refresh-data.js, app.js, index.html, squashlevels-overrides.json and run a normal refresh.
