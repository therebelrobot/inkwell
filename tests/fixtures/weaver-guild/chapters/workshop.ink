=== workshop ===
Brass gears turn above the loom. #speaker: narrator
- (bench)
* [Pluck the low string]
    {play_note("c")} hums through the floorboards.
    ~ harmonies_learned += 1
    -> bench
+ [Search the drawers]
    {has_loom_key: Empty now.|You find a small iron key.}
    ~ has_loom_key = true
    -> bench
* {has_loom_key} [Unlock the archive] -> archive
* [Rest] -> rest_tunnel -> bench
+ [Leave the workshop] -> epilogue

=== rest_tunnel ===
You close your eyes for a while.
->->

=== forgotten_room ===
Nobody comes here.
-> END
