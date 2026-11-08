// What the Stream Deck shows and does, worked out from Ablecon's state.
// Plain functions with no Companion dependency, so they're easy to test.

/** How many numbered song and section variables/buttons there are. */
export const MAX_SONGS = 24;
export const MAX_SECTIONS = 24;

const SAME = 1e-3;

/** Setlist rows that are in the open Live set, in setlist order. */
export function playable(state) {
  return (state?.rows ?? []).filter((r) => !r.missing);
}

/** The row under the playhead, or null. */
export function rowAt(state, beats) {
  return playable(state).find((r) => beats >= r.start && beats < r.end) ?? null;
}

/** The song "this song" buttons are about: the one playing (or under the playhead), else the cued one, else the first. */
export function focusRow(state, position) {
  if (!state) return null;
  const beats = position?.beats ?? 0;
  return rowAt(state, beats) ?? playable(state).find((r) => r.songId === state.cuedId) ?? playable(state)[0] ?? null;
}

export function sectionIndexAt(row, beats) {
  return row ? row.sections.findIndex((s) => beats >= s.start && beats < s.end) : -1;
}

/** The song that comes next, as the page's "Up next" shows it. */
export function upNext(state, position) {
  if (!state) return null;
  const here = rowAt(state, position?.beats ?? 0);
  const songs = playable(state);
  if (here && state.cuedId && state.cuedId !== here.songId) return songs.find((r) => r.songId === state.cuedId) ?? null;
  const base = here ?? focusRow(state, position);
  if (!base) return null;
  if (here && !here.stopAtEnd) {
    const flow = songs.find((r) => Math.abs(r.start - here.end) < SAME);
    if (flow) return flow;
  }
  return songs[songs.indexOf(base) + 1] ?? null;
}

export function clock(seconds) {
  if (!Number.isFinite(seconds)) return '';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function signed(n) {
  return n > 0 ? `+${n}` : String(n);
}

/** "G", "G → A", "Key +2" or "" (as on the page). */
export function keyLabel(row) {
  if (!row) return '';
  const moved = row.semitones !== null && row.semitones !== 0;
  if (row.originalKey) return moved ? `${row.originalKey} → ${row.playedKey}` : row.originalKey;
  return moved ? `Key ${signed(row.semitones)}` : '';
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** The song's tempo: its own, else the one read from the set, else Live's. */
export function songTempo(row, position) {
  const bpm = row?.tempo ?? row?.seenTempo ?? position?.tempo;
  return Number.isFinite(bpm) ? round2(bpm) : null;
}

// ---- variables ----------------------------------------------------------------

export function variableDefinitions() {
  const defs = {
    connected: { name: 'Connected to Ableton Live (Yes/No)' },
    transport: { name: 'Playing or Stopped' },
    song_name: { name: 'Current song (playing, or ready to play)' },
    song_number: { name: 'Current song number in the setlist' },
    song_count: { name: 'Number of songs in the setlist' },
    song_key: { name: 'Current song key (e.g. G → A)' },
    song_tempo: { name: 'Current song tempo (BPM)' },
    live_tempo: { name: "Live's tempo right now (BPM)" },
    section_name: { name: 'Section the playhead is in' },
    next_section_name: { name: 'Next section in the current song' },
    up_next: { name: 'Song up next' },
    elapsed: { name: 'Time into the current song (m:ss)' },
    remaining: { name: 'Time left in the current song (m:ss)' },
    set_length: { name: 'Total running time of the setlist (m:ss)' },
    jump_countdown: { name: '"Next section" countdown, e.g. "Chorus in 5" (empty when not waiting)' },
  };
  for (let i = 1; i <= MAX_SONGS; i++) defs[`song_${i}`] = { name: `Setlist song ${i}` };
  for (let i = 1; i <= MAX_SECTIONS; i++) defs[`section_${i}`] = { name: `Section ${i} of the current song` };
  return defs;
}

export function variableValues(state, position, linkUp) {
  const values = {};
  const songs = playable(state);
  const focus = focusRow(state, position);
  const beats = position?.beats ?? 0;
  const here = rowAt(state, beats);
  const inside = !!(here && focus && here.songId === focus.songId);
  const secIdx = inside ? sectionIndexAt(focus, beats) : -1;
  const nextSection = focus ? (secIdx >= 0 ? focus.sections[secIdx + 1] : focus.sections.find((s) => s.start > beats)) : null;

  values.connected = linkUp && state?.connected ? 'Yes' : 'No';
  values.transport = position?.playing ? 'Playing' : 'Stopped';
  values.song_name = focus?.name ?? '';
  values.song_number = focus ? songs.indexOf(focus) + 1 : '';
  values.song_count = songs.length;
  values.song_key = keyLabel(focus);
  const bpm = songTempo(focus, position);
  values.song_tempo = bpm === null ? '' : bpm;
  values.live_tempo = Number.isFinite(position?.tempo) ? round2(position.tempo) : '';
  values.section_name = secIdx >= 0 ? focus.sections[secIdx].name : '';
  values.next_section_name = nextSection?.name ?? '';
  values.up_next = upNext(state, position)?.name ?? '';

  if (focus) {
    const tempoNow = inside ? position.tempo : bpm;
    const total = tempoNow ? ((focus.end - focus.start) * 60) / tempoNow : NaN;
    const elapsed = inside && tempoNow ? ((beats - focus.start) * 60) / tempoNow : 0;
    values.elapsed = clock(elapsed);
    values.remaining = clock(total - elapsed);
  } else {
    values.elapsed = '';
    values.remaining = '';
  }
  values.set_length = state ? clock(state.totalSeconds) : '';

  const pj = state?.pendingJump;
  values.jump_countdown = pj ? `${pj.name} in ${Math.max(0, Math.ceil(pj.at - beats - 1e-6))}` : '';

  for (let i = 1; i <= MAX_SONGS; i++) values[`song_${i}`] = songs[i - 1]?.name ?? '';
  for (let i = 1; i <= MAX_SECTIONS; i++) values[`section_${i}`] = focus?.sections[i - 1]?.name ?? '';
  return values;
}

// ---- feedback checks ----------------------------------------------------------------

function findTrack(state, name, group) {
  const n = String(name ?? '').trim().toLowerCase();
  const g = String(group ?? '').trim().toLowerCase();
  if (!n) return null;
  return (state?.tracks ?? []).find((t) => t.name.trim().toLowerCase() === n && (!g || (t.parents[0] ?? '').trim().toLowerCase() === g)) ?? null;
}

export const checks = {
  playing: (state, position) => !!position?.playing,
  live_connected: (state, position, linkUp) => !!(linkUp && state?.connected),
  /** Song n is the one playing or ready. */
  song_active: (state, position, linkUp, o) => {
    const f = focusRow(state, position);
    return !!f && playable(state).indexOf(f) === Number(o.number) - 1;
  },
  /** Song n is queued to play next while another song plays. */
  song_up_next: (state, position, linkUp, o) => {
    const row = playable(state)[Number(o.number) - 1];
    const here = rowAt(state, position?.beats ?? 0);
    return !!row && !!here && state.cuedId === row.songId && here.songId !== row.songId;
  },
  /** The playhead is in section n of the current song. */
  section_active: (state, position, linkUp, o) => {
    const f = focusRow(state, position);
    const here = rowAt(state, position?.beats ?? 0);
    return !!f && !!here && f.songId === here.songId && sectionIndexAt(f, position.beats) === Number(o.number) - 1;
  },
  /** Section n of the current song is looping. */
  section_looping: (state, position, linkUp, o) => {
    const f = focusRow(state, position);
    const s = f?.sections[Number(o.number) - 1];
    const loop = position?.loop;
    return !!s && !!loop?.enabled && Math.abs(loop.start - s.start) < SAME && Math.abs(loop.length - (s.end - s.start)) < SAME;
  },
  jump_pending: (state) => !!state?.pendingJump,
  track_muted: (state, position, linkUp, o) => !!findTrack(state, o.name, o.group)?.muted,
  track_soloed: (state, position, linkUp, o) => !!findTrack(state, o.name, o.group)?.soloed,
  any_solo: (state) => (state?.tracks ?? []).some((t) => t.soloed),
};

// ---- actions → Ablecon commands -------------------------------------------------------

function mode(v) {
  return v === 'on' || v === 'off' ? v : 'toggle';
}

/**
 * The Ablecon command for a button press, as [action, extra].
 * `state` is used where the press depends on what's happening (e.g. Next section cancels a waiting jump).
 */
export function commandFor(actionId, o, state) {
  switch (actionId) {
    case 'play': return ['play', {}];
    case 'stop': return ['stop', {}];
    case 'toggle_play': return ['togglePlay', {}];
    case 'next_song': return ['nextSong', {}];
    case 'previous_song': return ['previousSong', {}];
    case 'cue_song': return ['cueNumber', { number: Number(o.number) }];
    case 'start_song': return ['startNumber', { number: Number(o.number) }];
    case 'next_section':
      return state?.pendingJump && o.tapToCancel !== false ? ['cancelJump', {}] : ['nextSection', {}];
    case 'cancel_jump': return ['cancelJump', {}];
    case 'jump_section': return ['sectionNumber', { number: Number(o.number) }];
    case 'loop_section': return ['loopNumber', { number: Number(o.number) }];
    case 'loop_off': return ['loopOff', {}];
    case 'mute_track': return ['muteByName', { name: String(o.name ?? ''), group: String(o.group ?? ''), mode: mode(o.mode) }];
    case 'solo_track': return ['soloByName', { name: String(o.name ?? ''), group: String(o.group ?? ''), mode: mode(o.mode) }];
    case 'clear_solos': return ['clearSolos', {}];
    case 'reread': return ['refresh', {}];
    default: throw new Error(`unknown action ${actionId}`);
  }
}
