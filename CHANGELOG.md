# Changelog

Ablecon uses [semantic versioning](https://semver.org): MAJOR.MINOR.PATCH. A PATCH version only fixes
bugs, a MINOR version adds something that works with your existing setlist, Remote Script and Stream
Deck setup, and a MAJOR version changes something you'll need to redo or reinstall.

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
