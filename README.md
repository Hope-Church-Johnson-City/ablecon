# Ablcon

Run an Ableton Live set like a setlist, from any phone, tablet or laptop on your network.

Ablcon reads the locators in your arrangement, turns them into songs and sections, and gives you a
control page with transport buttons, a reorderable setlist, section jump and loop buttons, the running
time of the set, and a tempo and key for each song. Changing the setlist order never edits your Live set.

> **About the name:** "Ablcon" is a working name. Names that start with "Abl" are close to Ableton's
> trademark, so pick a different name before you release this publicly.

It has three parts:

| Part | What it does |
| --- | --- |
| **Ablcon.app** (Mac) | Runs the Ablcon server, shows the control page in a window and serves it to other devices on the network. |
| **Remote Script** (`remote_script/Ablcon`) | A small Python script that runs inside Live and talks to the app over localhost (OSC over UDP). No Max for Live needed. |
| **Control page** (`public/`) | The web page you open on a phone, tablet or laptop. Updates live over a WebSocket. |

Requires Ableton Live 11 or 12 (Ablcon uses the arrangement-clip access added in Live 11) and macOS.

---

## Setup

### 1. Install the app

Open `Ablcon-<version>-arm64.dmg` (Apple Silicon) or `Ablcon-<version>-x64.dmg` (Intel) and drag
**Ablcon** to **Applications**.

The app is not signed with an Apple Developer ID, so the first time macOS will refuse to open it.
Open it once anyway: try to open Ablcon, then go to **System Settings → Privacy & Security**, scroll
down and click **Open Anyway**. (On older macOS you can instead right-click the app and choose
**Open**.) When macOS asks whether Ablcon may accept incoming network connections, click **Allow**, or
phones and tablets won't be able to reach it.

### 2. Install the Remote Script

On first launch Ablcon offers to install it for you. You can also run **File → Install Remote Script
in Ableton Live…** at any time (for example after updating Ablcon).

To install it by hand instead, copy the `remote_script/Ablcon` folder (in the app it's in
`Ablcon.app/Contents/Resources/remote_script/Ablcon`) to:

```
~/Music/Ableton/User Library/Remote Scripts/Ablcon
```

If your User Library is somewhere else, Live shows its location under **Settings → Library**. Create
the `Remote Scripts` folder if it isn't there.

### 3. Turn it on in Live

1. Restart Live.
2. Open **Settings** (called **Preferences** in Live 11) → **Link, Tempo & MIDI**.
3. In an empty **Control Surface** slot choose **Ablcon**. Leave its **Input** and **Output** set to **None**.

The dot at the top of the Ablcon page turns green and shows your Live version once they're connected.
If it doesn't, see [Troubleshooting](#troubleshooting).

### 4. Open it on other devices

Choose **File → Open on Other Devices…** in the app. It lists addresses like `http://192.168.1.20:8420`.
Open one in Safari or Chrome on any device on the same network. Tip: on an iPad or iPhone, use
**Share → Add to Home Screen** to get a full-screen button for it.

---

## Naming your locators

Ablcon builds songs and sections from the arrangement locators (Live's "cue points"). The rule:

| Locator name | Meaning |
| --- | --- |
| `*Song Title` | A song starts here. A space after the `*` is fine (`* Song Title`). |
| `--` | The current song ends here. Optional. Without it a song ends where the next song starts. |
| `// anything` | Ignored. Use it for notes to yourself. |
| anything else | A section of the song it falls in (`Intro`, `Verse 1`, `Chorus`, `End`…). |

Example arrangement:

```
beat   0  // Pre-service loop        (ignored)
beat   8  *Morning Light             song 1 starts
beat   8  Intro                      section
beat  16  Verse 1                    section
beat  48  Chorus                     section
beat 176  Outro                      section
beat 192  --                         song 1 ends (the gap after it is never played by Ablcon)
beat 200  *River Wide                song 2 starts
beat 200  Intro
beat 248  Chorus
beat 312  *Still Waters              song 2 ends, song 3 starts
beat 312  Verse
beat 392  End                        just a section name
beat 408  --                         song 3 ends
```

Details:

- A section runs until the next section or the end of the song. Put a section locator at the very start
  of a song if you want a button for it (a song locator and a section locator can share the same beat).
- The last song ends at its `--`, or at the end of the arrangement if it has none.
- Locators outside any song are ignored, and the page lists them under **Locator notes** so you can
  spot typos. That list also warns about empty songs and repeated song names.
- Songs are matched to setlist entries by name (not case-sensitive). Renaming a song's locator makes it a
  new song; the old entry stays in the setlist marked **Not in Live set** so you don't lose its tempo
  and key. Remove it in Edit mode once you're sure. If two songs have the same name, the second is told
  apart by its order.
- Ablcon notices locator changes in Live within about a second. **Settings → Re-read locators** forces it.

---

## Using it

- **Tap a song** to get it ready. If Live is stopped, the playhead moves to it and its tempo and key are
  set. If Live is playing, it becomes **Up next** and plays when the current song ends.
- **▶ next to a song** jumps straight to it and plays.
- **Play / Stop.** Pressing Stop while already stopped returns to the start of the current song.
  The space bar also starts and stops when the page has focus.
- **Next song** gets the following song in the setlist ready (or queues it while playing).
- **Sections:** with **Tap jumps**, a section button moves the playhead there and keeps playing.
  With **Tap loops**, it turns on Live's loop around that section (tap again, or **Loop off**, to stop
  looping). The looping section is highlighted blue.
- **Edit** shows the reorder arrows (↑ ↓), the tempo box and the key buttons for each song.
- **Set** in the top bar is the total running time of every song in the setlist. Songs without their own
  tempo are timed at Live's current tempo. Tempo automation inside a song isn't taken into account.

### When a song ends (Settings)

- **Stop and get the next song ready** (default): Live stops at the song's end marker and the playhead
  moves to the next song in the setlist (or the one you queued), with its tempo and key applied.
- **Go straight into the next song:** jumps to the next song and keeps playing. Its tempo is set at the jump.
- **Keep playing the arrangement:** Ablcon does nothing; Live plays on as normal.

Ablcon sees the playhead about ten times a second, so Live may play a fraction of a beat past the end
marker before it stops or jumps. Leave a little silence before `--` (or between songs).

### Tempo per song

Type a BPM in the song's tempo box (leave it empty to keep whatever Live is set to). Ablcon sets Live's
song tempo when the song is cued while stopped, or when it starts. It doesn't change the tempo while
another song is playing. If your set has tempo automation, the automation wins once playback reaches it.

### Key per song

Use − / + to pick a key change from −12 to +12 semitones. **Off** means Ablcon leaves the song's pitch
alone. When the song is cued or started, Ablcon:

- sets **Transpose** (`pitch_coarse`) on every **warped audio clip** that **starts inside the song**, on
  every track, to the chosen number of semitones;
- on MIDI tracks, sets the **Pitch** parameter of each **Pitch** MIDI effect (Live's built-in one, placed
  directly on the track, not inside a rack) to the same number;
- never touches tracks whose name, or whose group's name, contains `[nokey]`. Put this on click, guide,
  cue and spoken-word tracks. You can change the tag in Settings.

The value is absolute: a key change of +2 sets clips to +2, and setting a song back to 0 resets its
clips to 0. Leave clip Transpose at 0 in your set and let Ablcon manage it for songs that have a key set.

To avoid audible glitches Ablcon never changes anything that is currently sounding:

- Live stopped: everything is applied right away.
- Live playing a different song: the cued song's audio clips change straight away (they aren't playing),
  but Pitch devices wait, because they affect the whole track, including what's playing now.
- Live playing inside that song: everything waits.

Anything that has to wait is applied as soon as Live stops. The song shows a **Key waiting** tag until
then. **Apply** (in Edit mode) applies a song's key on demand, following the same rules.

The ⚠ tag on a song means there's something you should look at, listed under the song in Edit mode:

- an audio clip that isn't warped (Live can't transpose it; turn on **Warp**),
- a clip that starts before the song (left alone) or runs past its end (transposed as a whole),
- a MIDI track with clips in the song but no Pitch device,
- a change Live refused (for example a track renamed since Ablcon read it; just apply again).

### Where the setlist is saved

- In the Mac app: `~/Library/Application Support/Ablcon/ablcon-setlist.json`
  (**File → Show Setlist File in Finder**).
- When running from source with `npm start`: `ablcon-setlist.json` in the project folder, next to the
  server. Set `ABLCON_SETLIST=/path/to/file.json` to use another file, for example one per Live set.

It's plain JSON (order, tempo, key per song, and the two settings), safe to back up or copy between machines.

---

## Troubleshooting

- **Dot stays red ("Live not found")**: check that Ablcon is chosen as a Control Surface in Live, and
  that you restarted Live after installing the script. Live writes the script's messages to its log
  (`~/Library/Preferences/Ableton/Live <version>/Log.txt`); search it for `Ablcon:`. A message like
  `could not open UDP port 11100` means another program is using that port.
- **"Port 8420 is already in use"**: another Ablcon is running (perhaps from Terminal). Quit it.
- **Phones can't connect**: they must be on the same network as the Mac, and macOS must allow incoming
  connections for Ablcon (**System Settings → Network → Firewall → Options**). Some guest Wi-Fi networks
  block devices from talking to each other.
- **A song is missing**: its locator name must start with `*`. Check **Locator notes** on the page.

Note that anyone who can open the page on your network can control Live. There is no password in v1;
use it on a network you trust.

---

## Running from source

Needs Node.js 22.18 or newer (Node runs the TypeScript directly) and Python 3 for the tests.

```bash
npm install
```

```bash
npm start
```

starts the server only; open `http://localhost:8420`. To try everything without Ableton Live, run the
fake Live in a second terminal first. It runs the real Remote Script request handlers against a pretend
Live set with three songs and moves the playhead while "playing":

```bash
npm run fake-live
```

Other commands:

| Command | What it does |
| --- | --- |
| `npm run app` | Builds and runs the Mac app in development. |
| `npm run dist` | Builds `release/Ablcon-<version>-arm64.dmg` and `-x64.dmg` (unsigned). |
| `npm run icon` | Redraws `build/icon.png`. |
| `npm run test:all` | Type check, Node tests and Python tests. |

Environment variables: `ABLCON_PORT` (web page, default 8420), `ABLCON_LIVE_PORT` (Remote Script UDP
port, default 11100; the script itself always listens on 11100), `ABLCON_SETLIST` (setlist file, `npm start` only).

### Layout

```
app/main.js            Mac app (Electron): starts the server, window, menus, Remote Script installer
src/server.ts          HTTP + WebSocket server for the control page
src/controller.ts      Ties Live, the setlist and the rules together
src/locators.ts        Locator naming rule → songs and sections
src/setlist.ts         Setlist order, tempo, key, durations, JSON file
src/planning.ts        Tempo/key planning, what is safe to change while playing, end-of-song logic
src/liveClient.ts      Talks to the Remote Script (requests, chunked replies, position pushes)
src/osc.ts             OSC 1.0 message encoder/decoder
public/                Control page (plain HTML/CSS/JS, no build step)
remote_script/Ablcon/  The Remote Script that runs inside Live
remote_script/fake_live/  Fake Live set + UDP server for development and tests
test/                  Node tests (node:test), including a TypeScript fake Live
remote_script/tests/   Python tests for the Remote Script
```

### Protocol between the app and Live

OSC messages over UDP on 127.0.0.1. The script listens on port 11100 and replies to whoever asked.

| Direction | Address | Arguments |
| --- | --- | --- |
| app → Live | `/ablcon/req` | `id:int`, `method:string`, `args:JSON string` |
| Live → app | `/ablcon/res` | `id:int`, `part:int`, `parts:int`, `chunk:string` (joined chunks are `{"ok":true,"result":…}` or `{"ok":false,"error":…}`) |
| Live → app | `/ablcon/pos` | `beats:float`, `playing:int`, `tempo:float`, `loop:int`, `loopStart:float`, `loopLength:float` (sent when it changes) |
| Live → app | `/ablcon/changed` | `"cues"` when locators change |

Methods: `ping`, `state`, `cues`, `play`, `continue`, `stop`, `jump {beats}`, `tempo {bpm}`,
`loop {start, length, enabled}`, `tracks {start, end}`, `apply {ops}`. Replies are split into chunks of
6000 ASCII characters to stay under macOS's 9216-byte UDP datagram limit.

### Tests

`npm run test:all` runs:

- **OSC encoding**: known bytes, every argument type, malformed input (Node and Python).
- **Locator parsing**: the naming rule, ordering, end markers, comments, duplicates, warnings.
- **Setlist**: matching to Live, reordering, missing songs, tempo/key validation, durations, file round-trip.
- **Tempo and key planning**: `[nokey]` tags (including on groups), warped/unwarped clips, clips crossing
  song edges, Pitch devices and their range, what may change while playing, end-of-song detection.
- **Against a fake Live over real UDP**: request/response, chunked replies, timeouts, position pushes,
  cueing, queued songs while playing, stop at song end, section loops.
- **End to end with the real Remote Script handlers** running in Python against a fake Live set.
- **Remote Script** (Python): request handling, track/clip/device reporting, applying changes, chunking.

---

## What has not been checked against a real Live

Everything above was tested without Ableton Live, against fakes that model the parts of Live's API
Ablcon uses. These still need checking in Live 11 and 12 with a real set:

- That Live loads the script as written (a plain class with no MIDI ports, not a subclass of Live's
  `ControlSurface` framework) and calls `update_display()` about every 100 ms to drive it.
- That changing the song (tempo, playhead, loop, clip transpose, device parameters) from
  `update_display()` is allowed.
- The exact Live API names and values used: `cue_points`, `current_song_time`, `song_length`,
  `Track.arrangement_clips`, `Clip.pitch_coarse`, `Clip.warping`, `Track.group_track`, `is_foldable`, and
  that the Pitch MIDI effect reports `class_name` `"MidiPitcher"` with a parameter named `"Pitch"`.
- That moving the playhead while stopped and then pressing Play starts from that point.
- How far past a song's end Live plays before Ablcon stops it, and whether that is audible.
- Running time for songs in time signatures other than x/4 (Ablcon assumes Live's beat counts match its BPM).
- The Mac app: it was built and launched on Apple Silicon and served the page against the fake Live.
  The Intel build was not launched, the **Install Remote Script** menu was not run (to avoid writing
  into a real Live library), and the unsigned-app and firewall prompts weren't walked through.

## Not in v1

Synced lyrics, redundant playback across two computers, Stream Deck support and OSC output to other
devices.
