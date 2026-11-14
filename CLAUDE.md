# Ablecon: rules for working on this project

Ablecon is a setlist and remote control for Ableton Live, used live at church services by Jeremy
(worship tech). A regression can stop a service, so **nothing that already works may break.**

## Git: fork, branch, pull request (from Brant, org owner)

**Never commit or push directly to the church repo** (`Hope-Church-Johnson-City/ablecon`, remote
`upstream`). All work goes through Jeremy's fork (`jpalacio146/ablecon`, remote `origin`):

1. Start from the latest church main: `git switch main && git pull` (main tracks `upstream/main`).
2. Make a branch for the change: `git switch -c <short-description>`. Never commit on `main`.
3. Commit there (the checks below must pass), then push the branch to the fork:
   `git push -u origin <branch>`.
4. Open a pull request from the fork into the church repo:
   `gh pr create --repo Hope-Church-Johnson-City/ablecon --base main --head jpalacio146:<branch>`.
5. Merge the pull request on GitHub:
   `gh pr merge <number> --repo Hope-Church-Johnson-City/ablecon --merge --delete-branch`.
6. Bring this Mac and the fork up to date: `git switch main && git pull && git push origin main`.

Enforced on this Mac: `.githooks/pre-commit` refuses commits on `main`/`master`;
`.githooks/pre-push` refuses any push to the church repo; and `upstream`'s push URL is disabled.
Don't work around these (no `--no-verify`, no re-enabling the push URL).

Enforced on GitHub for everyone, admins included (repository rulesets, set up by Brant 2026-11-09):
**"main: pull requests only"** (main changes only by a merged pull request; no force-push, no
deleting it) and **"No branches here: work in a fork"** (no branch other than main can be created in
the church repo, so every pull request comes from a fork). Releases still work: `npm run release`
only adds a tag. The church repo is public, so forks are public too.

**Always open a PR and merge whenever a new version is ready** (from Brant). A version is ready when
`npm run check` passes and Jeremy is happy with the change (if he asked to see it first, wait for his
OK). Then do steps 3–6 without asking: push the branch, open the pull request, merge it, and bring
this Mac and the fork up to date. Still never push or merge work that isn't finished or that fails
the checks.

## Versions: semantic versioning (from Brant)

Ablecon's version is `"version"` in `package.json` (shown in **About Ablecon** and at the bottom of the
page's Settings, and in the installer's name), written `MAJOR.MINOR.PATCH`. Every pull request that
changes what Jeremy installs bumps it, in the same pull request:

- **PATCH** (1.1.0 → 1.1.1): bug fixes only; nothing new to learn.
- **MINOR** (1.1.1 → 1.2.0): a new feature or changed behaviour that still works with existing setlist
  files, the installed Remote Script and the Stream Deck setup. Reset PATCH to 0.
- **MAJOR** (1.2.0 → 2.0.0): something that breaks what's there: a setlist file older versions can't
  read, a removed feature, Stream Deck buttons that must be redone, a Remote Script older apps can't use.
  Reset MINOR and PATCH to 0.

Keep `package-lock.json`'s version in step (`npm version <x.y.z> --no-git-tag-version` does both), and
add an entry at the top of `CHANGELOG.md` in plain words. Changes to only tests, docs or these rules
don't bump. The Remote Script (`SCRIPT_VERSION`) and the Companion module
(`companion-module/package.json` and `companion/manifest.json`, kept equal) have their own versions,
bumped by the same rules when they change. `test/version.test.ts` checks all of this.

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
6. **Shipping:** releases are GitHub Releases of the church repo, made by `npm run release` on a Mac
   (README: "Releasing a new version"). Bump the version and add the CHANGELOG entry in a pull request;
   once it's merged, check out main, run `npm run release -- --dry-run`, then `npm run release`.
   **Every new version of Ablecon gets a release, without asking** (from Brant, 2026-11-13: "every
   time we have a new version, build and push the app and the Companion module, both in a new
   release"): the release holds both installers, the Companion module package
   (`companion-module/<id>-<version>.tgz`) and `SHA256SUMS.txt` for all three
   (`npm run release -- --assets` lists them). Never reuse a released version: bump PATCH instead. Publishing a release is
   the one thing that writes to the church repo directly, and only on a commit already merged to main.
   `npm run dist` alone builds `release/Ablecon-<version>-arm64.dmg` for local testing. Before telling
   Jeremy to install, check for stale installer disks in `/Volumes` and whether Ablecon is running
   (port 8420).
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
- Edit mode: controls never move when a value changes (Key on its own fixed line, fixed-width value,
  Off/Apply space always reserved, fixed-shape title row); nothing sticks out of a song box.
- Stream Deck: the Companion module in `companion-module/` (Companion 5.1+, module API 2.2): presets,
  actions, feedbacks and variables, tested in `test/companion.test.mjs` with the real module class
  under a stand-in Companion; Ablecon's button commands (next/previous song, song/section number,
  play toggle, mute/solo by name). Loaded in Jeremy's Companion from `~/Companion Modules/ablecon`
  (a link to `companion-module/`). **The module's package is kept in the repo** (from Brant,
  2026-11-13: "always build it and store the tgz in the repo itself"):
  `companion-module/<id>-<version>.tgz`, current version only. The pre-commit hook rebuilds it with
  `npm run companion:package` (`scripts/companion-package.mjs`) and stages it; the packaging test in
  `test/companion.test.mjs` fails if the committed package doesn't match the module.
- Companion setup (`src/companion.ts`, `app/main.js`; from Brant, 2026-11-13: find Companion on the
  local system, configure the module, keep it configured, and upgrade it when a new Ablecon first
  starts): the installer carries `companion-module/*.tgz`; at launch and every minute Ablecon talks to
  Companion on this Mac over its tRPC WebSocket (`/trpc`, address from Companion's `config.json`),
  imports the module if that version is missing, adds an `ablecon` connection if there's none, moves
  older-version connections up and re-enables them. Never while Live plays; `dev` connections and
  newer versions untouched. Tested against a stand-in Companion in `test/companion-setup.test.ts`
  (calls and shapes taken from Companion 5.1.3's source; not yet tried against a real Companion).
  `ABLECON_COMPANION_URL` points at another Companion, `ABLECON_NO_COMPANION` turns it off.
- Waveform in the now panel: all stems mixed (not click/guide/Sections/muted), lined up by warp
  markers, section bands and names, bar lines, played part bright; built in the background with
  `afconvert`, cached in `ablecon-waveforms/` next to the setlist; plain line until ready.
- Section loops, six looks (per device; **Ableton** is the default), outdated Remote Script warning,
  phone layout.
- One-click updates (`src/update.ts`, `app/main.js`): newer GitHub release found at launch and every 6 h,
  installer checked against `SHA256SUMS.txt`, never installed while Live plays or a jump waits, old
  app kept in `previous-version`, failed swaps put the old app back, Settings shows the notice.
  `ABLECON_UPDATE_FEED` points the app at a test feed and installs without asking (testing only).

## Layout

`src/` server (TypeScript, run directly by Node), `public/` page, `app/main.js` Mac app (Electron),
`remote_script/Ablecon/` the script inside Live, `test/` and `remote_script/tests/` tests,
`scripts/ui-check.mjs` page check, `companion-module/` the Stream Deck (Companion) module. See README.md
for the full description.
