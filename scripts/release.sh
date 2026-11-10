#!/bin/bash
# Builds the Mac installers on this Mac and publishes them as a GitHub Release
# of the church repo (Hope-Church-Johnson-City/ablecon), tagged v<version>.
#
#   npm run release              build, then publish
#   npm run release -- --dry-run build only; shows what would be published
#   npm run release -- --notes   just print the release notes (from CHANGELOG.md)
#
# It only releases exactly what is on the church repo's main, with a version
# that has a CHANGELOG.md entry and hasn't been released before. Nothing in git
# is changed or pushed: GitHub makes the tag on that main commit.
# See "Releasing a new version" in README.md.
set -euo pipefail

REPO="Hope-Church-Johnson-City/ablecon"
DRY_RUN=0
NOTES_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --notes) NOTES_ONLY=1 ;;
    *) echo "Unknown option: $arg (use --dry-run, --notes or nothing)"; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."
fail() { echo "Release stopped: $*" >&2; exit 1; }
# In a dry run the "is this the right commit" checks only warn.
check() { if [ "$DRY_RUN" = 1 ]; then echo "Warning (dry run, would stop a release): $*"; else fail "$*"; fi; }

VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"

# 1. The release notes: this version's CHANGELOG entry, plus how to install.
NOTES=$(mktemp -t ablecon-notes)
trap 'rm -f "$NOTES"' EXIT
awk -v v="$VERSION" '
  $0 == "## " v { on = 1; next }
  on && /^## / { exit }
  on && /^[[:space:]]*$/ { if (started) blanks++; next }
  on { while (blanks > 0) { print ""; blanks-- }; print; started = 1 }
' CHANGELOG.md > "$NOTES"
[ -s "$NOTES" ] || fail "CHANGELOG.md has no \"## $VERSION\" section to use as the release notes"
cat >> "$NOTES" <<EOF

---

**Install:** download \`Ablecon-$VERSION-arm64.dmg\` for an Apple Silicon Mac (M1 or newer) or
\`Ablecon-$VERSION-x64.dmg\` for an Intel Mac, open it and drag Ablecon to Applications. Quit Ablecon
first if it's running. The app isn't signed, so the first time macOS asks, go to System Settings →
Privacy & Security → **Open Anyway**. If these notes mention the Remote Script, choose
**File → Install Remote Script in Ableton Live…** afterwards and restart Live.
EOF

if [ "$NOTES_ONLY" = 1 ]; then cat "$NOTES"; exit 0; fi

echo "Ablecon $VERSION"
command -v gh >/dev/null || fail "the GitHub CLI (gh) isn't installed: brew install gh"
gh auth status >/dev/null 2>&1 || fail "gh isn't signed in: gh auth login"

# 2. Exactly the church repo's main, with nothing uncommitted.
[ -z "$(git status --porcelain)" ] || check "there are uncommitted changes (git status)"
MAIN_SHA=$(gh api "repos/$REPO/commits/main" --jq .sha)
HEAD_SHA=$(git rev-parse HEAD)
[ "$HEAD_SHA" = "$MAIN_SHA" ] || check "this checkout ($(git rev-parse --short HEAD)) isn't the church repo's main ($(echo "$MAIN_SHA" | cut -c1-7)). Run: git switch main && git pull"
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  check "$TAG is already released. Bump the version in a pull request first (README: Releasing a new version)"
fi

# 3. Checks, then the installers.
echo "Running npm run check..."
npm run check --silent
echo "Building the installers..."
rm -rf release
npm run dist --silent
ARM="release/Ablecon-$VERSION-arm64.dmg"
X64="release/Ablecon-$VERSION-x64.dmg"
[ -f "$ARM" ] && [ -f "$X64" ] || fail "the build didn't make $ARM and $X64"
(cd release && shasum -a 256 "Ablecon-$VERSION-arm64.dmg" "Ablecon-$VERSION-x64.dmg" > SHA256SUMS.txt)

echo
echo "Release notes for $TAG:"
sed 's/^/  | /' "$NOTES"
echo
ls -lh "$ARM" "$X64" release/SHA256SUMS.txt

if [ "$DRY_RUN" = 1 ]; then
  echo
  echo "Dry run: nothing published. Without --dry-run this makes release $TAG on $REPO."
  exit 0
fi

# 4. Publish. GitHub tags the main commit checked above.
gh release create "$TAG" "$ARM" "$X64" release/SHA256SUMS.txt \
  --repo "$REPO" --target "$MAIN_SHA" --title "Ablecon $VERSION" --notes-file "$NOTES"
echo "Published: https://github.com/$REPO/releases/tag/$TAG"
