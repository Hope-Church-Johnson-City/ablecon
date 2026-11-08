// Ablecon's version, from package.json. Ablecon uses semantic versioning
// (MAJOR.MINOR.PATCH); see "Versions" in CLAUDE.md and CHANGELOG.md.

import { readFileSync } from 'node:fs';

export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// package.json sits one folder up from both src/ and dist/.
export const APP_VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
