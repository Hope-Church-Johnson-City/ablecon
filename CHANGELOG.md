# Changelog

Ablecon uses [semantic versioning](https://semver.org): MAJOR.MINOR.PATCH. A PATCH version only fixes
bugs, a MINOR version adds something that works with your existing setlist, Remote Script and Stream
Deck setup, and a MAJOR version changes something you'll need to redo or reinstall.

## 1.5.0

- **Stream Deck buttons set themselves up.** When Ablecon sets up a new Companion connection, it also
  adds the button page from Jeremy's Mac as a page called **Ablecon**: songs 1–10, Play, Stop, Next
  song and Next section on a 15-key Stream Deck. On a new Companion it becomes page 1; otherwise it's a
  new page at the end, and no page of yours is replaced. A Companion that already has Ablecon keeps its
  own buttons; there, **File → Set Up Stream Deck (Companion)** offers to add the page.
- The page is also in the project as `companion-module/ablecon-buttons.companionconfig`, for importing
  by hand into a Companion on another computer.

## 1.4.0

- **Track outputs.** In the Tracks panel, switch **Mute / Solo** to **Outputs**: each track gets a
  picker for where its sound goes (Out 1–8 and pairs on your audio interface, Main, its group, or Sends
  Only), and the **Master** gets one at the top. Changes are heard straight away. A track moved away from
  its normal place shows in orange.
- **Output presets.** Set things up (for example Click → Out 1, Guide → Out 2, Master → Out 3/4, Bass →
  Out 5), type a name and press **Save current**; later pick it and press **Apply**. Presets go by track
  name, so "Bass → Out 5" moves the Bass in every song, and they work in every Live set.
- Needs the new Remote Script (1.6.0): choose **File → Install Remote Script in Ableton Live…**, then
  restart Live. Ablecon reminds you if Live still has the old one; everything else keeps working until
  then.

## 1.3.1

- Fix: on a Mac where Ablecon was downloaded from GitHub, macOS said **"Ablecon" is damaged and
  can't be opened**. Ablecon wasn't damaged: its built-in signature was incomplete, which macOS
  treats that way. The app is now signed properly, so the first time you open it macOS only asks once:
  go to **System Settings → Privacy & Security** and click **Open Anyway**.

## 1.3.0

- Ablecon sets up its Stream Deck module in Bitfocus Companion (5.1 or newer) on the same Mac by
  itself: it imports the module, adds the `ablecon` connection, and keeps both there. When a new
  Ablecon starts for the first time, it brings Companion's module up to its version too. Your buttons
  and the connection's address stay as they are, and nothing changes while Live is playing.
- **File → Set Up Stream Deck (Companion)** does it right away and says what it did.

## 1.2.1

- Each release now includes the Stream Deck module for Bitfocus Companion
  (`hopechurch-ablecon-1.2.0.tgz`). To install or update it, choose **Modules → Import module
  package** in Companion; your buttons stay as they are.
- The module is now MIT licensed, which is what lets Companion install it from that one file.
- Fix: Ablecon now only listens to Ableton Live's Remote Script. Before, a stray message from another
  program on the Mac could briefly show the wrong playhead position.

## 1.2.0

- Ablecon updates itself. It checks for a new version when it opens and every 6 hours, and offers to
  install it (**Update Now**). It downloads the right installer for the Mac, checks it, then quits and
  reopens as the new version. It never installs while Live is playing.
- **Ablecon → Check for Updates…** checks by hand; **Ablecon → Show Previous Version in Finder** shows the
  version before the last update, kept so you can go back.
- The page's Settings says when a newer Ablecon is available.
- After an update that comes with a newer Remote Script, Ablecon offers to install it.

## 1.1.0

- Versions now follow semantic versioning, listed here.
- The version of Ablecon (and of the Remote Script running in Live) is shown at the bottom of Settings,
  so you can check which version each computer has. It's also in **Ablecon → About Ablecon**.

## 1.0.0

Every installer built before versions were kept was called 1.0.0. The last of them had:

- Songs and sections from locators (plain names with STOP markers, or `*Song` style) and the Sections
  track; one setlist per Live set.
- Play, Stop, Next song, cueing and Up next; songs stop only at STOP markers and otherwise play
  straight into the next one.
- Tempo and key per song, read from the markers; tempo shown next to the key.
- Next section on a bar line, section loops.
- Tracks panel with mute and solo, folded by group.
- Six looks (Ableton is the default) and a phone layout.
- Stream Deck module for Bitfocus Companion.
- A waveform of the whole song (all stems) with coloured sections in the now panel.
