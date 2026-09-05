SQUASHLEVELS HARD PROFILE OVERRIDES

This package re-introduces hard SquashLevels profile overrides into the current refresh pipeline.

Overrides included:
- Philip Taylor -> player 462936
- Kuan-Chan Lin -> player 227851

Julian Buczek is NOT overridden. His existing SquashLevels mapping is left untouched.

Keep squashlevels-overrides.json beside refresh-data.js in the repository root.
The override URL wins before automatic same-name/country/age matching.
The forced profile is still opened during the normal authenticated metrics phase, so World ranking and Level are refreshed from that profile.
