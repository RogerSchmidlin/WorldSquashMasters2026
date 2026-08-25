SquashLevels nickname fallback
==============================

Edit squashlevels-nicknames.json to add/remove first-name equivalence groups.
Each group is bidirectional. Example:

  ["Steven", "Stephen", "Steve"]

Fallback is attempted only when the normal exact-name mapping did not resolve.
The fallback validates candidates in this order:

1. exact last name
2. exact country
3. exact age group
4. unique first-name match from squashlevels-nicknames.json

If more than one candidate still matches, no profile is selected.

API metadata validation update:
- Nickname candidate country and age are parsed directly from SquashLevels search API result data.
- Example: "Sue Hillier (O60)" + "AUS - Vic Park, Western Australia" -> AUS / O60.
- Validation order remains surname -> country -> age group -> nickname equivalence.
