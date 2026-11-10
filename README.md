# Ablecon

Run an Ableton Live set like a setlist, from any phone, tablet or laptop on your network.

Ablecon reads the locators in your arrangement, turns them into songs and sections, and gives you a
control page with transport buttons, a reorderable setlist, section jump and loop buttons, the running
time of the set, a tempo and key for each song, and mute buttons for your tracks. Changing the setlist order never edits your Live set.

> **About the name:** "Ablecon" (said "ABLE-con") is one letter away from "Ableton", which is a
> trademark. That's fine for your own use, but pick a clearly different name before sharing or
> releasing this publicly.
>
> **Renamed from "Ablcon":** the Ablecon app carries over the old app's setlist (tempos, keys, order)
> and each device's look and panel settings the first time it runs. Its Remote Script is now called
> **Ablecon**: install it from the File menu, which moves the old "Ablcon" script to the Trash, then
> restart Live and choose **Ablecon** as the Control Surface. Delete the old Ablcon app from
> Applications.

It has three parts:

| Part | What it does |
| --- | --- |
| **Ablecon.app** (Mac) | Runs the Ablecon server, shows the control page in a window and serves it to other devices on the network. |
| **Remote Script** (`remote_script/Ablecon`) | A small Python script that runs inside Live and talks to the app over localhost (OSC over UDP). No Max for Live needed. |
| **Control page** (`public/`) | The web page you open on a phone, tablet or laptop. Updates live over a WebSocket. |

Requires Ableton Live 11 or 12 (Ablecon uses the arrangement-clip access added in Live 11) and macOS.

---

## Setup

### 1. Install the app

Download the newest installer from the church repo's
[Releases page](https://github.com/Hope-Church-Johnson-City/ablecon/releases) (you need to be signed in
to GitHub with access to the repo): `Ablecon-<version>-arm64.dmg` for an Apple Silicon Mac (M1 or
newer) or `Ablecon-<version>-x64.dmg` for an Intel Mac. Open it and drag **Ablecon** to
**Applications** (quit Ablecon first if you're updating). Each release's notes say what changed.

The app is not signed with an Apple Developer ID, so the first time macOS will refuse to open it.
Open it once anyway: try to open Ablecon, then go to **System Settings → Privacy & Security**, scroll
down and click **Open Anyway**. (On older macOS you can instead right-click the app and choose
**Open**.) When macOS asks whether Ablecon may accept incoming network connections, click **Allow**, or
phones and tablets won't be able to reach it.

### 2. Install the Remote Script

On first launch Ablecon offers to install it for you. You can also run **File → Install Remote Script
in Ableton Live…** at any time (for example after updating Ablecon).

To install it by hand instead, copy the `remote_script/Ablecon` folder (in the app it's in
`Ablecon.app/Contents/Resources/remote_script/Ablecon`) to:

```
~/Music/Ableton/User Library/Remote Scripts/Ablecon
```

If your User Library is somewhere else, Live shows its location under **Settings → Library**. Create
the `Remote Scripts` folder if it isn't there.

### 3. Turn it on in Live

1. Restart Live.
2. Open **Settings** (called **Preferences** in Live 11) → **Link, Tempo & MIDI**.
3. In an empty **Control Surface** slot choose **Ablecon**. Leave its **Input** and **Output** set to **None**.

The dot at the top of the Ablecon page turns green and shows your Live version once they're connected.
If it doesn't, see [Troubleshooting](#troubleshooting).

### 4. Open it on other devices

Choose **File → Open on Other Devices…** in the app. It lists addresses like `http://192.168.1.20:8420`.
Open one in Safari or Chrome on any device on the same network. Tip: on an iPad or iPhone, use
**Share → Add to Home Screen** to get a full-screen button for it.

---

## Naming your locators

Ablecon builds songs from the arrangement locators (Live's "cue points"), and sections from either a
**Sections** track or more locators. It understands two layouts and picks one automatically.

### Plain layout (typical multitrack sets)

Used when no locator name starts with `*`. This is how most worship multitrack sets are already built:

| In the set | Meaning |
| --- | --- |
| A locator, e.g. `How Great Thou Art (F)` | A song starts here. A key in brackets at the end (`(G)`, `(Bb)`, `(Em)`…) is read as the song's original key. |
| A locator named `STOP` (or `--`) | The current song ends here, and playback stops here (see [When a song ends](#when-a-song-ends)). Without one, a song ends where the next one starts and Live plays straight on into it. |
| A locator starting with `//` | Ignored. |
| Clips on a track named **Sections** | Each clip that starts inside a song becomes a section button, named after the clip (`Count Off`, `Intro`, `Verse 1`…). The clip's length doesn't matter: a section runs until the next one. |

```
Locators:     It Really Is Amazing Grace (G)          STOP  King Of Kings (C)        How Great Thou Art (F) …
Sections:     [Count Off][Intro][Verse 1][Chorus]…[Ending]  [Count Off][Intro][Verse 1]…[Outro][Count Off][Intro]…
Click / Guide / one group of stems per song
```

The Sections track can be a MIDI track with empty clips; Ablecon only reads the clip names and positions.
If your track has another name, set it in **Settings → Track whose clips mark the sections** (leave it empty
to turn this off).

### Marked layout

Used as soon as any locator name starts with `*`. Songs and sections are both locators:

| Locator name | Meaning |
| --- | --- |
| `*Song Title` | A song starts here (a space after the `*` is fine). A key in brackets works here too. |
| `--` or `STOP` | The current song ends here, and playback stops here. Without one, the song runs straight on into the next. |
| `// anything` | Ignored. |
| anything else | A section of the song it falls in (`Intro`, `Verse 1`, `Chorus`, `End`…). |

```
beat   0  // Pre-service loop        (ignored)
beat   8  *Morning Light (G)         song 1 starts, original key G
beat   8  Intro                      section
beat  16  Verse 1                    section
beat 176  Outro                      section
beat 192  --                         song 1 ends
beat 200  *River Wide                song 2 starts
beat 200  Intro
beat 312  *Still Waters              song 2 ends, song 3 starts
beat 392  End                        just a section name
beat 408  --                         song 3 ends
```

A song with no section locators still gets its sections from the Sections track, if there is one.

### Details

- A section runs until the next section or the end of the song.
- The last song ends at its end marker, or at the end of the arrangement if it has none.
- In the marked layout, locators outside any song are ignored. The page lists them under
  **Locator notes** so you can spot typos. That list also warns about empty songs and repeated song names.
- Songs are matched by title, not case-sensitive and ignoring the key in brackets, so changing `(G)` to
  `(A)` in a locator keeps the song's tempo and key settings. Renaming a song makes it a new song. If the
  old name had a tempo or key, it stays in the setlist marked **Not in Live set** so you don't lose them;
  remove it in Edit mode once you're sure. If two songs have the same title, the second is told apart by
  its order.
- Ablecon notices changes to locators and to the Sections track's clips within about a second.
  **Settings → Re-read locators** forces it (needed if your sections track has a name other than
  "Sections", or if you're still using the Remote Script from an older Ablecon).

---

## Using it

- **The waveform** under the song's title shows the whole song: every stem mixed into one outline,
  over a coloured band for each section with its name (verse blue, pre-chorus yellow, chorus orange,
  bridge purple, instrumental or interlude green, tag or outro pink, intro and others grey), faint bar
  lines and a white playhead. The part already played is bright. Ablecon reads the audio files behind
  the song's clips (with macOS's own `afconvert`) and lines them up with the bars using Live's warp
  markers, so it matches the arrangement whatever the tempo. Click and guide tracks, the Sections
  track, and muted tracks and clips are left out, so it shows what the room hears. The first time a set
  is opened this takes a few seconds (about 7 for a four-song set); what was read is kept in an
  `ablecon-waveforms` folder next to the setlist file, and a file is only read again if it changes.
  Your audio files are only read, never changed. Until a song's waveform is ready (or if an audio file
  can't be read, for example one in iCloud that isn't downloaded) you see a plain line with the
  section bands. Tapping the waveform does nothing, so a stray tap can't move the song. Needs Remote
  Script 1.5.0 or newer.
- **Tap a song** to get it ready. If Live is stopped, the playhead moves to it and its tempo and key are
  set. If Live is playing, it becomes **Up next**: at the current song's end, Ablecon goes to it (stopping
  first if there's a STOP marker).
- **▶ next to a song** jumps straight to it and plays.
- **Play / Stop.** Play always starts from where the page says the playhead is ("Ready at …"), not
  from Live's insert marker. Stop while a song is queued gets that song ready (playhead, tempo, key).
  Pressing Stop while already stopped returns to the start of the current song. The space bar also
  starts and stops when the page has focus.
- **Next song** gets the following song in the setlist ready (or queues it while playing).
- **Sections:** with **Tap jumps**, a section button moves the playhead there and keeps playing.
  With **Tap loops**, it turns on Live's loop around that section (tap again, or **Loop off**, to stop
  looping). The looping section is highlighted blue.
- **Next section** (above the section buttons) goes to the next section of the current song. While Live
  is playing, it waits and jumps on the second bar line after your tap (tap halfway through bar 5 and
  it jumps when bar 7 would start), so the new section starts on a downbeat. The button counts down
  ("→ Chorus in 5 beats") and the target section is highlighted; tap it again to cancel. Stop, Play,
  or jumping somewhere else also cancels it. If the next section would start before then anyway, there
  is nothing to jump over and it says so. When Live is stopped it moves there straight away. The wait
  can be 1, 2 or 4 bars (**Settings**). Bars are counted from the start of the arrangement in the set's
  time signature, so time-signature changes inside the set can throw the count off. The timing runs
  inside Live (Remote Script 1.4.1 or newer): the jump happens on Live's last update before the bar
  line, into the matching point just before the new section, so its downbeat lands on time.
- Each song in the setlist shows its **key** and then its **tempo**. A tempo you set in Ablecon is
  highlighted; a grey one is the tempo at the song's locator in your Song Tempo automation. Live only
  reports the tempo at the playhead, so when Ablecon connects, when you edit locators, or when you open
  another set, it quickly moves the playhead to each song's locator (about a quarter of a second each),
  reads the tempo, and puts the playhead back. Nothing plays, and it waits if Live is playing. After
  changing tempo automation, **Settings → Re-read locators** reads the tempos again. (Press Play in Live
  during those few seconds and playback starts at whichever song was being read.)
- **Edit** shows the reorder arrows (↑ ↓), the tempo box and the key buttons for each song.
- **Tracks** gives every track an **M** (mute) and **S** (solo) button, laid out compactly:
  - Tracks outside any group (click, guide…) are at the top. The Sections track is left out, since muting
    it does nothing useful.
  - Each group folds up to one row with its own **M** and **S**: tap its name to open or close it. The row
    says how many tracks are in it and how many of those are muted or soloed.
  - The group for the song that's playing (or ready) opens by itself and is marked **This song**. Ablecon
    matches group names to song titles and forgives small spelling slips ("Kign Of Kings").
    Groups you open or close by hand stay that way on that device.
  - **M** turns red when a track is muted, **S** yellow when it's soloed. Solos add up (soloing a second
    track keeps the first soloed); **Clear solos** appears whenever anything is soloed. A track whose name
    is faded is silent only because another track is soloed.
  - Changes take effect immediately, even mid-song, and changes you make in Live show up on every device
    within a fraction of a second. Solo needs Remote Script 1.2.0 or newer (**File → Install Remote Script
    in Ableton Live…**, then restart Live). **Hide** folds the whole panel away on that device.
- **Set** in the top bar is the total running time of every song in the setlist. A song with its own
  tempo in the setlist is timed at that tempo. Otherwise Ablecon uses the tempo at the song's locator
  in the tempo automation (see above). Tempo changes in the middle of a song aren't
  taken into account.

### Looks

**Settings → Look** changes how the page looks on that device (each phone, tablet or laptop keeps its
own): **Ableton** (the default: the greys, orange, green, red and yellow of Live's dark theme, with
squarer corners), **Stage** (dark slate, amber, the original look), **Blackout** (pure black, bigger and brighter, for a
dark stage), **Daylight** (light, for bright rooms), **Sanctuary** (warm browns and gold, serif titles)
or **Compact** (Stage colours, tighter, fits more on a laptop). **Compare all looks side by side** opens
live previews of all six. A device where a look was already picked keeps it until you change it. Adding `?look=blackout` (etc.) to the address forces a look without saving it.

### When a song ends

Ablecon only ever stops at a `STOP` (or `--`) marker. Every other boundary is played straight through:

- **No STOP after a song:** Live keeps playing into the song that follows it in the arrangement, whatever
  the setlist order. As playback crosses into it, Ablecon sets that song's tempo (if you gave it one).
  Its stems are transposed ahead of time, while the song before is still playing, so the key is already
  right when it starts. Pitch devices on MIDI tracks are the exception: they affect every song, so they
  only change when a song is cued or started. If you queued a different song with **Next song** or by
  tapping it, playback jumps to that song at the boundary instead and keeps playing.
- **A STOP after a song:** what happens is set in **Settings → When a song ends**:
  - **Stop and get the next song ready** (default): Live stops at the STOP marker and the playhead moves
    to the next song in the setlist (or the one you queued), with its tempo and key applied.
  - **Go straight into the next song:** jumps to that song and keeps playing. Its tempo is set at the jump.
  - **Keep playing the arrangement:** Ablecon does nothing at STOP markers; Live plays on as normal.

Under the transport buttons, **Up next** shows what follows the current song and how: "plays straight
on" or "after the STOP".

Ablecon sees the playhead about ten times a second, so Live may play a fraction of a beat past a STOP
marker before it stops or jumps. Leave a little silence before each STOP.

### Tempo per song

Type a BPM in the song's tempo box. Leave it empty to use the set's own tempo (its Song Tempo
automation, if it has some). A song's tempo only applies to that song:

- When the song is cued while stopped, starts, or playback runs into it, Ablecon sets Live's tempo.
  It doesn't change the tempo while another song is still playing.
- If the set has tempo automation, Live treats this like moving the tempo by hand. It overrides the
  automation (everywhere, not just in that song) and lights its **Re-enable Automation** button.
- As soon as the playhead is in a song with no tempo of its own, whether you tap it, play straight into
  it, or move there in Live, Ablecon re-enables the automation. The rest of the set keeps its automated
  tempos.

Live doesn't let scripts edit the automation lane itself, so this is done by overriding and
re-enabling. Re-enabling brings back any other automation you overrode by hand too (a volume you rode,
for example), the same as clicking Live's Re-enable Automation button. This needs Remote Script 1.3.0
or newer; with an older one the page asks you to update it.

### Key per song

Use − / + to pick a key change from −12 to +12 semitones. If the song's locator has its key in brackets,
the page shows the result, e.g. **G → A**. **Off** means Ablecon leaves the song's pitch
alone. When the song is cued or started, Ablecon:

- sets **Transpose** (`pitch_coarse`) on every **warped audio clip** that **starts inside the song**, on
  every track, to the chosen number of semitones;
- on MIDI tracks, sets the **Pitch** parameter of each **Pitch** MIDI effect (Live's built-in one, placed
  directly on the track, not inside a rack) to the same number;
- never touches the Sections track, or tracks whose name, or whose group's name, contains one of the
  words in **Settings → Never transpose tracks whose names contain**. The default is `[nokey], click, guide`,
  which covers tracks like "Click Foundations" and "Guide". Add `[nokey]` to any other track that should
  stay put (spoken word, cues), or edit the list.

The value is absolute: a key change of +2 sets clips to +2, and setting a song back to 0 resets its
clips to 0. Leave clip Transpose at 0 in your set and let Ablecon manage it for songs that have a key set.

To avoid audible glitches Ablecon never changes anything that is currently sounding:

- Live stopped: everything is applied right away.
- Live playing a different song: the cued song's audio clips change straight away (they aren't playing),
  but Pitch devices wait, because they affect the whole track, including what's playing now.
- Live playing inside that song: everything waits.

A clip belongs to the song it starts in. Stems often run a little past their song's end: such a clip is
transposed with its own song, and the next song leaves it alone. Ablecon doesn't warn about this.

Anything that has to wait is applied as soon as Live stops. The song shows a **Key waiting** tag until
then. **Apply** (in Edit mode) applies a song's key on demand, following the same rules.

The ⚠ tag on a song means there's something you should look at, listed under the song in Edit mode:

- an audio clip that isn't warped (Live can't transpose it; turn on **Warp**),
- a MIDI track with clips in the song but no Pitch device,
- a change Live refused (for example a track renamed since Ablecon read it; just apply again).

### One setlist per Live set

Each Live set gets its own setlist. Live doesn't tell a script which file is open, so Ablecon recognises
a set by its songs: when you open a set, it uses the saved setlist with mostly the same songs (so
renaming, adding or removing a song keeps your order). A set with mostly different songs, like next
Sunday's, starts a new setlist in arrangement order. The last 60 sets are remembered.

A song's **tempo and key belong to the song**, not the set: give King Of Kings a key once and it comes
along to every later set that has King Of Kings.

### Where the setlist is saved

- In the Mac app: `~/Library/Application Support/Ablecon/ablecon-setlist.json`
  (**File → Show Setlist File in Finder**).
- When running from source with `npm start`: `ablecon-setlist.json` in the project folder, next to the
  server. Set `ABLECON_SETLIST=/path/to/file.json` to use another file, for example one per Live set.

It's plain JSON (each set's song order, each song's tempo and key, and the settings), safe to back up or
copy between machines. A file from before setlists were kept per set is converted the first time it's
used: songs from other sets that have no tempo or key are dropped.

---

## Stream Deck (Bitfocus Companion)

The `companion-module/` folder is a module for [Bitfocus Companion](https://bitfocus.io/companion)
(5.1 or newer) that controls Ablecon from a Stream Deck or any other Companion surface. It talks to
Ablecon the same way the page does, so Companion can run on the same Mac or another computer.

**Ready-made buttons** (Buttons → Presets → ablecon): Play/Stop, Play, Stop, Previous/Next song (shows
what's up next), Next section (counts down; press again to cancel), Loop off, Clear solos; songs 1–12
with their names (green when playing or ready, orange when up next); sections 1–16 of the current
song (orange where the playhead is, blue when looping); displays for now playing, key and tempo, set
length and the Live connection; mute buttons for the click and guide tracks. They come without Companion's top
bar (the page and button number at the top of each key). For buttons made before module 1.1.0, set
**Settings → Buttons → Default decoration** in Companion to **Border (when pressed)**.

**Actions** for your own buttons: play, stop, play/stop, next/previous song, cue or play song number,
next section, cancel the jump, jump to or loop section number, loop off, mute or solo a track by name
(with an optional group name), clear solos, re-read locators. **Variables** such as
`$(ablecon:song_name)`, `section_name`, `up_next`, `remaining`, `song_key`, `song_tempo`,
`jump_countdown` and `song_1`…`song_24` can go in any button's text.

### Installing the module

Companion loads it from a *developer modules* folder (no packaging needed):

1. Install the module's libraries once: `npm install` in the project (or `npm install` inside
   `companion-module/`).
2. Make a folder for Companion modules, e.g. `~/Companion Modules`, and put the `companion-module`
   folder in it (a copy, or a link: `ln -s ~/Projects/ablcon/companion-module ~/Companion\ Modules/ablecon`).
3. In Companion's launcher window, click the cog → **Advanced Settings** → **Developer** → **Select**
   that folder, and turn on **Enable Developer Modules**.
4. Open Companion's page → **Connections** → **Add Connection** → **Ablecon**. Keep address
   `127.0.0.1` and port `8420` if Ablecon runs on the same computer; otherwise use the address from
   Ablecon's **File → Open on Other Devices**.

Companion reloads the module by itself when its files change. (Companion's packaging tool,
`npm run companion:package`, only builds modules under an open-source licence such as MIT, so this
module isn't packaged as a single file.)

## Troubleshooting

- **Dot stays red ("Live not found")**: check that Ablecon is chosen as a Control Surface in Live, and
  that you restarted Live after installing the script. Live writes the script's messages to its log
  (`~/Library/Preferences/Ableton/Live <version>/Log.txt`); search it for `Ablecon:`. A message like
  `could not open UDP port 11100` means another program is using that port.
- **"Port 8420 is already in use"**: another Ablecon is running (perhaps from Terminal). Quit it.
- **Phones can't connect**: they must be on the same network as the Mac, and macOS must allow incoming
  connections for Ablecon (**System Settings → Network → Firewall → Options**). Some guest Wi-Fi networks
  block devices from talking to each other.
- **A song is missing**: its locator name must start with `*`. Check **Locator notes** on the page.

Note that anyone who can open the page on your network can control Live. There is no password in v1;
use it on a network you trust.

---

## Making changes

The church repo, [Hope-Church-Johnson-City/ablecon](https://github.com/Hope-Church-Johnson-City/ablecon),
only changes through pull requests. Work in your own fork, on a branch:

```bash
gh repo fork Hope-Church-Johnson-City/ablecon --clone   # once
git switch -c my-change                                  # never commit on main
npm run check                                            # must pass (the commit hook runs it too)
git push -u origin my-change
gh pr create --repo Hope-Church-Johnson-City/ablecon --base main
```

The hooks in `.githooks/` (enabled by `npm install`) refuse commits on `main` and any direct push to
the church repo.

**Versions** follow [semantic versioning](https://semver.org) (MAJOR.MINOR.PATCH, in `package.json`):
bump PATCH for a bug fix, MINOR for a new feature that works with existing setlists, Remote Script and
Stream Deck setups, MAJOR for anything people must redo or reinstall, and add a line to
[CHANGELOG.md](CHANGELOG.md). `npm version <x.y.z> --no-git-tag-version` sets it. Which version a
computer runs is shown in **Ablecon → About Ablecon** and at the bottom of **Settings** on any device,
next to the Remote Script version.

### Releasing a new version

Installers are built on a Mac and published as a
[GitHub Release](https://github.com/Hope-Church-Johnson-City/ablecon/releases) of the church repo,
tagged `v<version>`. The `.dmg` files live on the Releases page, not in git.

1. **Bump the version in a pull request** like any other change: `npm version <x.y.z>
   --no-git-tag-version`, a new `## x.y.z` entry at the top of [CHANGELOG.md](CHANGELOG.md) (it becomes
   the release notes, so write it for the people installing it), commit on a branch, pull request, merge.
2. **Check out the merged main** with nothing uncommitted:

   ```bash
   git switch main && git pull
   ```

3. **Try it first** (builds everything, publishes nothing, and shows the release notes):

   ```bash
   npm run release -- --dry-run
   ```

4. **Publish:**

   ```bash
   npm run release
   ```

`npm run release` (`scripts/release.sh`) stops unless this checkout is exactly the church repo's
`main`, the version hasn't been released yet and CHANGELOG.md has an entry for it. Then it runs
`npm run check`, builds both installers with `npm run dist`, and creates the release with `gh`:
GitHub tags that `main` commit `v<version>` and attaches `Ablecon-<version>-arm64.dmg`,
`Ablecon-<version>-x64.dmg` and `SHA256SUMS.txt`. The notes are the CHANGELOG entry plus install steps
(`npm run release -- --notes` prints them). Nothing is pushed: the release is made on a commit that's
already on `main` through a pull request. It needs the GitHub CLI signed in (`gh auth login`) with
write access to the church repo.

A release that went wrong is never replaced under the same version: fix it, bump PATCH and release
again. To take a bad one down, delete it on the Releases page and delete its tag on GitHub under
**Tags** (a `git push --delete` to the church repo is refused by the hook).

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
Live set with three songs laid out like a multitrack set (plain locators, `STOP` markers, a Sections
track, click, guide and a group of stems per song) and moves the playhead while "playing". Add
`-- --set marked` for the `*Song` layout instead:

```bash
npm run fake-live
```

Other commands:

| Command | What it does |
| --- | --- |
| `npm run app` | Builds and runs the Mac app in development. |
| `npm run dist` | Builds `release/Ablecon-<version>-arm64.dmg` and `-x64.dmg` (unsigned). |
| `npm run release` | Checks, builds and publishes the installers as a GitHub Release (see [Releasing a new version](#releasing-a-new-version)); `-- --dry-run` builds without publishing. |
| `npm run icon` | Redraws `build/icon.png`. |
| `npm run check` | Everything: type check, server tests, Remote Script tests and the page check. Commits are refused unless it passes (`.githooks/pre-commit`, enabled by `npm install`). |
| `npm run test:ui` | Just the page check: the real page in a hidden window against the fake Live, feature by feature. |

Environment variables: `ABLECON_PORT` (web page, default 8420), `ABLECON_LIVE_PORT` (Remote Script UDP
port, default 11100; the script itself always listens on 11100), `ABLECON_SETLIST` (setlist file, `npm start` only).

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
src/waveform.ts        Song waveforms: reads stems (afconvert), lines them up with warp markers, mixes them
public/                Control page (plain HTML/CSS/JS, no build step)
remote_script/Ablecon/  The Remote Script that runs inside Live
remote_script/fake_live/  Fake Live set + UDP server for development and tests
test/                  Node tests (node:test), including a TypeScript fake Live
remote_script/tests/   Python tests for the Remote Script
```

### Protocol between the app and Live

OSC messages over UDP on 127.0.0.1. The script listens on port 11100 and replies to whoever asked.

| Direction | Address | Arguments |
| --- | --- | --- |
| app → Live | `/ablecon/req` | `id:int`, `method:string`, `args:JSON string` |
| Live → app | `/ablecon/res` | `id:int`, `part:int`, `parts:int`, `chunk:string` (joined chunks are `{"ok":true,"result":…}` or `{"ok":false,"error":…}`) |
| Live → app | `/ablecon/pos` | `beats:float`, `playing:int`, `tempo:float`, `loop:int`, `loopStart:float`, `loopLength:float` (sent when it changes) |
| Live → app | `/ablecon/changed` | `"cues"` when locators change, `"tracks"` when track names or mutes change |

Methods: `ping`, `state`, `cues`, `play`, `continue`, `stop`, `jump {beats}`, `tempo {bpm}`,
`loop {start, length, enabled}`, `tracks {start, end}`, `apply {ops}`, `mixer`,
`mute {track, trackName, muted}`, `solo {track, trackName, soloed}`, `clear_solos`, `play_from {beats}`,
`restore_tempo`, `jump_at {at, to}`, `cancel_jump`, `audio_clips {start, end}` (each audio clip's file,
start marker, warp markers and mute, for the waveform). Replies are split into chunks of
6000 ASCII characters to stay under macOS's 9216-byte UDP datagram limit.

### Tests

`npm run check` runs everything below, plus the page check (`scripts/ui-check.mjs`), which opens the real page in a hidden window against the fake Live and checks each feature: songs, keys and tempos from markers, sections, cueing, Play position, Up next, key and tempo editing, Next section, groups, mute and solo, looks, the waveform, phone layout and page errors. It runs:

- **OSC encoding**: known bytes, every argument type, malformed input (Node and Python).
- **Locator parsing**: both layouts, including the locators and Sections clips of a real worship set,
  `STOP` markers, keys in song names, ordering, comments, duplicates, warnings.
- **Keys**: reading `(G)`, `(Bb)`, `(Em)` from names, transposing and spelling them.
- **Setlist**: matching to Live, reordering, missing songs, tempo/key validation, durations, file round-trip.
- **One setlist per Live set**: recognising a set by its songs, separate orders for different sets,
  settings following a song between sets, converting the old shared setlist (tested with a real one).
- **Tempo and key planning**: `[nokey]` tags (including on groups), warped/unwarped clips, clips crossing
  song edges, Pitch devices and their range, what may change while playing, end-of-song detection.
- **Track mutes**: listing tracks, muting and unmuting, refusing a track that was renamed or moved,
  picking up mutes made in Live, and mutes not waiting behind a slow transport or key command.
- **Song ends**: stopping only at STOP markers, playing straight through other boundaries with the next
  song's tempo and stems ready, and jumping to a queued song instead.
- **Against a fake Live over real UDP**: request/response, chunked replies, timeouts, position pushes,
  cueing, queued songs while playing, stop at song end, section loops.
- **End to end with the real Remote Script handlers** running in Python against a fake Live set.
- **Waveform**: warp-marker timing (with markers from a real set), split stems that start partway into
  their file, unwarped and looped clips, mixing stems, leaving out click/guide/Sections and muted audio,
  reading WAV data, reading real files with `afconvert` and the saved copies, rebuilding only when stems
  change, and old Remote Scripts or unreadable audio. The page check plays the fake set's stems from
  generated audio (silent half, loud half) and checks the drawing follows it.
- **Remote Script** (Python): request handling, track/clip/device reporting, applying changes, mutes, chunking.

---

## What has not been checked against a real Live

Most of Ablecon was tested against fakes that model the parts of Live's API it uses. Checked in a real
Live set so far: the Remote Script loads and connects, locators and the Sections track are read
correctly, the track list and mutes, and starting playback exactly at a song or section. The waveform
was built for all four songs of a real set (44 stems, .m4a and .wav) and looked right by eye, but not yet
watched against the playhead during real playback. Waveforms are rebuilt when locators change, when Live
reconnects or with **Settings → Re-read locators**; moving or editing stems alone doesn't trigger it.

How Ablecon starts playback, learned from testing in Live: moving the playhead while Live is stopped
changes only the display. Live's Play starts from its start marker, and "continue" starts where
playback last stopped. So Ablecon's Remote Script moves Live's start marker (`Song.start_time`) as
well. That also means Live's own space bar starts at the song you picked in Ablecon. With an older
Remote Script (before 1.1.0), Ablecon starts playback and then jumps, so a moment of the wrong audio can
be heard; the page asks you to update the script when that happens.

Still to check in Live 11 and 12:

- Changing clip transpose and device parameters, and section loops (tempo and playhead changes work).
- How cleanly a **Next section** jump sounds in a real set (the timing logic is tested against the fakes).
- Setting `Clip.pitch_coarse`, and that the Pitch MIDI effect reports `class_name` `"MidiPitcher"` with a
  parameter named `"Pitch"`. (Reading locators, arrangement clips, `warping` and groups works.)
- Muting and soloing from Ablecon, `Track.muted_via_solo`, and that checking every track's mute state ten times a
  second costs nothing noticeable in a large set.
- How far past a song's end Live plays before Ablecon stops it, and whether that is audible.
- Running time for songs in time signatures other than x/4 (Ablecon assumes Live's beat counts match its BPM).
- The Mac app: it was built and launched on Apple Silicon and served the page against the fake Live.
  The Intel build was not launched, the **Install Remote Script** menu was not run (to avoid writing
  into a real Live library), and the unsigned-app and firewall prompts weren't walked through.

## Not in v1

Synced lyrics, redundant playback across two computers, Stream Deck support and OSC output to other
devices.
