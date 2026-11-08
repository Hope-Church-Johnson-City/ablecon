## Ablecon

Controls **Ablecon**, the setlist and remote-control app for Ableton Live, from a Stream Deck or any
other Companion surface.

### Setup

1. Ablecon must be running (with the Ablecon Remote Script selected in Live).
2. Add this connection. If Ablecon runs on the same computer as Companion, keep the address
   `127.0.0.1` and port `8420`. Otherwise enter the address Ablecon shows under
   **File → Open on Other Devices** (e.g. `192.168.1.20`, port `8420`).
3. Open **Presets → Ablecon** and drag buttons onto your Stream Deck.

### Ready-made buttons (Presets)

- **Transport**: Play/Stop, Play, Stop, Previous/Next song (shows what's up next), Next section
  (waits for the bar line and counts down; press again to cancel), Loop off, Clear solos.
- **Setlist**: songs 1–12 with their names; green when playing or ready, orange when up next.
- **Sections**: sections 1–16 of the current song; orange where the playhead is, blue when looping.
- **Displays**: now playing (song, section, time left), key and tempo, set length, Live connection.
- **Tracks**: mute buttons for the click and guide tracks. Edit the track name to match your set.

### Actions

Play, Stop, Play/Stop, Next song, Previous song, Cue song number, Play song number, Next section,
Cancel next-section jump, Jump to section number, Loop section number, Loop off, Mute track,
Solo track (by name, with an optional group name), Clear solos, Re-read locators and tempos.

### Variables

`song_name`, `song_number`, `song_count`, `song_key`, `song_tempo`, `live_tempo`, `section_name`,
`next_section_name`, `up_next`, `elapsed`, `remaining`, `set_length`, `jump_countdown`, `transport`,
`connected`, and `song_1`…`song_24`, `section_1`…`section_24`.

Use them in button text as `$(ablecon:song_name)` (replace `ablecon` with your connection's name).
