# Ablecon: rules for working on this project

Ablecon is a setlist and remote control for Ableton Live, used live at church services by Jeremy
(worship tech). A regression can stop a service, so **nothing that already works may break.**

## Every change

1. **`npm run check` must pass before anything is committed.** It runs the type check, the server
   tests (`test/`), the Remote Script tests (`remote_script/tests/`) and the page check
   (`scripts/ui-check.mjs`, the real page in a hidden window against the fake Live). The pre-commit
   hook in `.githooks/` enforces this. Never commit with `--no-verify` unless Jeremy explicitly asks.
2. **Every feature and every fix gets a test** in the layer it lives in:
   - server logic: `test/*.test.ts` (use `test/fakeLive.ts` for anything that talks to Live);
   - Remote Script: `remote_script/tests/test_remote_script.py` (fake Live in `remote_script/fake_live/`);
   - anything visible on the page: a check in `scripts/ui-check.mjs`.
   For a bug fix, confirm the new test fails without the fix (put the bug back, run, restore).
3. **Never weaken or delete an existing test or check to make a change pass.** If a test's
   expectation really should change, say so to Jeremy and explain why.
4. **Keep the fakes honest.** When real Live behaves differently from a fake, change the fake to match
   Live and add a test (e.g. Live's Play starts at the start marker, not the playhead).
5. **Remote Script changes:** bump `SCRIPT_VERSION` in `remote_script/Ablecon/handlers.py` and
   `EXPECTED_SCRIPT_VERSION` in `src/controller.ts` together (a test checks they match). Install the
   script to `~/Music/Ableton/User Library/Remote Scripts/Ablecon` and tell Jeremy to restart Live.
6. **Shipping:** `npm run dist` builds `release/Ablecon-<version>-arm64.dmg`. Before telling Jeremy to
   install, check for stale installer disks in `/Volumes` and whether Ablecon is running (port 8420).
7. **Testing against Jeremy's real Live set** (when Ablecon isn't running and Live is stopped): use a
   copy of his setlist file (`~/Library/Application Support/Ablecon/ablecon-setlist.json`), run the dev
   server on port 8421, and put the playhead back afterwards. Say beforehand if anything will play.
8. Update the README when behaviour changes, and report honestly what was and wasn't verified.

## What already works (each item has tests; keep it working)

- Songs from locators: plain names (`Song (G)`) with `STOP`/`--` markers, or `*Song` style; keys read
  from names; sections from the **Sections** track's clips or from locators.
- One setlist per Live set, recognised by its songs; tempo/key belong to the song; songs missing from
  the set are only kept if they have a tempo or key; the old shared file converts on first use.
- Play/▶ start exactly at the cued song (start marker moved, `play_from`), Stop readies a queued song,
  Stop while stopped returns to the song's start.
- Song ends: stop only at STOP markers; otherwise play straight into the next song with its tempo set
  and stems pre-transposed; a queued song wins at the boundary.
- Tempo per song: overrides Live's tempo only for that song; automation re-enabled for other songs;
  tempos read at each marker while stopped (playhead restored); shown next to the key.
- Key per song: warped audio clips that start in the song, Pitch devices on MIDI tracks; never the
  Sections track or tracks/groups named with `[nokey]`, `click`, `guide`; nothing sounding is changed.
- Next section: waits for the configured bar line (default 2), jumps on Live's last tick before it so
  the downbeat is on time, countdown and cancel on the page.
- Tracks panel: groups fold, current song's group opens (fuzzy name match), Sections hidden, M and S
  buttons per track and group, Clear solos.
- Section loops, six looks (per device; **Ableton** is the default), outdated Remote Script warning,
  phone layout.

## Layout

`src/` server (TypeScript, run directly by Node), `public/` page, `app/main.js` Mac app (Electron),
`remote_script/Ablecon/` the script inside Live, `test/` and `remote_script/tests/` tests,
`scripts/ui-check.mjs` page check. See README.md for the full description.
