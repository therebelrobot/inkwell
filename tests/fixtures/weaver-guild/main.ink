// The Weaver Guild
// Tags: #speaker: name
INCLUDE chapters/workshop.ink
INCLUDE chapters/archive.ink
EXTERNAL play_note(note_name)
EXTERNAL camera_shake()

VAR harmonies_learned = 0
VAR has_loom_key = false
LIST notes = c, d, e, g, a

-> workshop

=== function play_note(note_name) ===
~ return note_name

=== epilogue ===
The guild lamps dim one by one. #speaker: narrator
-> END
