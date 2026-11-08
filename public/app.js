// Ablecon web UI. Plain JavaScript, no build step.
'use strict';

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
};

let state = null;
let position = { beats: 0, playing: false, tempo: 120, loop: { enabled: false, start: 0, length: 0 } };
let socket = null;
let nextId = 1;
let editing = false;
let tapMode = 'jump';
let renderDeferred = false;
let tracksOpen = true;
try { tracksOpen = localStorage.getItem('ablecon.tracksOpen') !== 'no'; } catch { /* storage blocked */ }

// ---- formatting --------------------------------------------------------------

function clock(seconds) {
  if (!Number.isFinite(seconds)) return '–';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
const keyText = (n) => (n > 0 ? `+${n}` : String(n));
const bpmText = (n) => `${Math.round(n * 100) / 100} BPM`;

/**
 * The song's tempo: one set in Ablecon (highlighted), the tempo Live plays it
 * at (learned the first time the playhead is at the song), or unknown yet.
 */
function tempoTag(row) {
  if (row.tempo !== null) return el('span', { class: 'tag tempo set', title: 'Tempo set in Ablecon' }, bpmText(row.tempo));
  if (row.seenTempo != null) return el('span', { class: 'tag tempo', title: 'Tempo from the Live set' }, bpmText(row.seenTempo));
  return el('span', { class: 'tag tempo unknown', title: 'Tap or play this song once and Ablecon will read its tempo from Live' }, '– BPM');
}

/** "G", "G → A", or "Key +2" when the song name has no key. */
function keyLabel(row) {
  const moved = row.semitones !== null && row.semitones !== 0;
  if (row.originalKey) return moved ? `${row.originalKey} → ${row.playedKey}` : row.originalKey;
  return moved ? `Key ${keyText(row.semitones)}` : '';
}

// ---- connection ----------------------------------------------------------------

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${proto}://${location.host}/ws`);
  socket.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'state') {
      state = msg.state;
      position = state.position;
      render();
    } else if (msg.type === 'position') {
      position = msg.position;
      renderPosition();
    } else if (msg.type === 'notice') {
      toast(msg.notice.text, msg.notice.level);
    } else if (msg.type === 'result' && !msg.ok) {
      toast(msg.error, 'error');
    }
  };
  socket.onclose = () => {
    setLink(false, 'Server offline');
    setTimeout(connect, 1500);
  };
}

function send(action, extra = {}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    toast('Not connected to the Ablecon server.', 'error');
    return;
  }
  socket.send(JSON.stringify({ id: nextId++, action, ...extra }));
}

function setLink(on, text) {
  $('#link').classList.toggle('on', on);
  $('#link').classList.toggle('off', !on);
  $('#linkText').textContent = text;
}

function toast(text, level = 'info') {
  const t = el('div', { class: `toast ${level}` }, text);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), level === 'error' ? 6000 : 3500);
}

// ---- derived data --------------------------------------------------------------

const playable = () => (state ? state.rows.filter((r) => !r.missing) : []);
const rowAt = (beats) => playable().find((r) => beats >= r.start && beats < r.end) || null;
const rowById = (id) => (state ? state.rows.find((r) => r.songId === id) : null) || null;

function nextAfter(id) {
  if (!state) return null;
  const i = state.rows.findIndex((r) => r.songId === id);
  return state.rows.slice(i + 1).find((r) => !r.missing) || null;
}

/** The song the sections panel shows: the one playing, else the cued one. */
function focusRow() {
  return rowAt(position.beats) || rowById(state && state.cuedId) || playable()[0] || null;
}

// ---- rendering -----------------------------------------------------------------

function render() {
  if (!state) return;
  setLink(state.connected, state.connected ? `Live ${state.liveVersion || ''}`.trim() : 'Live not found');
  const warn = $('#scriptWarn');
  warn.classList.toggle('hidden', !(state.connected && state.scriptOutdated));
  if (state.scriptOutdated) {
    warn.textContent = `Live is running an older Ablecon Remote Script (${state.scriptVersion}). Some features won't work until you update it: on the Mac running Live, choose File → Install Remote Script in Ableton Live…, then restart Live.`;
  }
  $('#setLength').textContent = clock(state.totalSeconds);
  $('#endOfSong').value = state.settings.endOfSong;
  $('#jumpBars').value = String(state.settings.jumpBars ?? 2);
  if (document.activeElement !== $('#noKeyTag')) $('#noKeyTag').value = state.settings.noKeyTag;
  if (document.activeElement !== $('#sectionsTrack')) $('#sectionsTrack').value = state.settings.sectionsTrack;

  const active = document.activeElement;
  if (active && active.matches('input') && $('#setlist').contains(active)) {
    renderDeferred = true; // don't yank an input out from under someone typing
  } else {
    renderSetlist();
  }
  renderWarnings();
  renderTracks();
  renderSections();
  renderPosition();
}

function renderSetlist() {
  renderDeferred = false;
  const list = $('#setlist');
  list.replaceChildren();
  list.parentElement.classList.toggle('editing', editing);
  if (state.rows.length === 0) {
    list.append(el('li', { class: 'hint' }, state.connected ? 'No songs found. Name a locator like "*Song Title" to start one.' : 'Waiting for Live…'));
    return;
  }
  state.rows.forEach((row, i) => list.append(songItem(row, i)));
}

function songItem(row, i) {
  const tags = [];
  const keyTag = keyLabel(row);
  if (keyTag) tags.push(el('span', { class: 'tag key', title: row.semitones ? `${keyText(row.semitones)} semitones` : 'Original key' }, keyTag));
  if (!row.missing) tags.push(tempoTag(row));
  if (row.key && row.key.pending) tags.push(el('span', { class: 'tag pending', title: 'Finishes when Live stops' }, 'Key waiting'));
  if (row.key && (row.key.warnings.length || row.key.error)) tags.push(el('span', { class: 'tag warn' }, '⚠'));
  if (row.missing) tags.push(el('span', { class: 'tag warn' }, 'Not in Live set'));

  const main = el('div', { class: 'main', onclick: () => !editing && !row.missing && send('cue', { songId: row.songId }) },
    el('span', { class: 'num' }, String(i + 1)),
    el('span', { class: 'name' }, row.name),
    el('span', { class: 'tags' }, tags),
    el('span', { class: 'dur' }, row.seconds === null ? '' : clock(row.seconds)),
    row.missing ? null : el('button', {
      class: 'go-btn', title: 'Play this song now', 'aria-label': `Play ${row.name} now`,
      onclick: (e) => { e.stopPropagation(); send('start', { songId: row.songId }); },
    }, '▶'),
  );

  // Fixed rows, so no control ever moves when a value changes (a key change
  // used to push the Key controls onto a new line under the user's finger).
  const edit = el('div', { class: 'edit' },
    el('div', { class: 'edit-row' },
      el('button', { class: 'small', disabled: i === 0, 'aria-label': 'Move up', onclick: () => send('move', { from: i, to: i - 1 }) }, '↑'),
      el('button', { class: 'small', disabled: i === state.rows.length - 1, 'aria-label': 'Move down', onclick: () => send('move', { from: i, to: i + 1 }) }, '↓'),
      el('label', {}, 'Tempo',
        el('input', {
          type: 'number', inputmode: 'decimal', min: 20, max: 999, step: 'any', placeholder: 'as set',
          value: row.tempo ?? '',
          onchange: (e) => send('tempo', { songId: row.songId, tempo: e.target.value }),
          onblur: () => renderDeferred && setTimeout(renderSetlist, 0),
        })),
      row.missing ? el('button', { class: 'small', onclick: () => send('remove', { songId: row.songId }) }, 'Remove') : null),
    row.missing ? null : el('div', { class: 'edit-row' }, keyStepper(row)),
    row.key && row.key.warnings.length ? el('ul', { class: 'warnlist' }, row.key.warnings.map((w) => el('li', {}, w))) : null,
    row.key && row.key.error ? el('div', { class: 'err' }, row.key.error) : null,
  );

  const cls = ['song'];
  if (row.missing) cls.push('missing');
  if (state.cuedId === row.songId) cls.push('cued');
  return el('li', { class: cls.join(' '), 'data-id': row.songId }, main, edit);
}

function keyStepper(row) {
  const value = row.semitones;
  const set = (n) => send('key', { songId: row.songId, semitones: n });
  return el('span', { class: 'stepper' },
    el('label', {}, 'Key'),
    // − value + stay together; Off and Apply may go to the next line on a narrow screen.
    el('span', { class: 'knob' },
      el('button', { class: 'small', disabled: value !== null && value <= -12, onclick: () => set((value ?? 0) - 1), 'aria-label': 'Key down' }, '−'),
      el('output', {}, value === null ? 'off' : row.originalKey ? `${keyText(value)} (${row.playedKey})` : keyText(value)),
      el('button', { class: 'small', disabled: value !== null && value >= 12, onclick: () => set((value ?? 0) + 1), 'aria-label': 'Key up' }, '+')),
    // Off and Apply always take their space (hidden while the key is off) so nothing shifts.
    el('button', { class: `small ghost${value === null ? ' reserve' : ''}`, disabled: value === null, 'aria-hidden': value === null ? 'true' : null, onclick: () => set(null), title: 'Stop managing the key of this song' }, 'Off'),
    el('button', { class: `small${value === null ? ' reserve' : ''}`, disabled: value === null, 'aria-hidden': value === null ? 'true' : null, onclick: () => send('applyKey', { songId: row.songId }) }, 'Apply'),
  );
}

function renderWarnings() {
  const box = $('#warnings');
  const list = state.warnings || [];
  box.classList.toggle('hidden', list.length === 0);
  box.replaceChildren(el('strong', {}, 'Locator notes'), el('ul', {}, list.map((w) => el('li', {}, w))));
}

// ---- tracks (mute panel) --------------------------------------------------------

// Groups the user opened or closed by hand on this device, by group name.
let groupChoice = {};
try { groupChoice = JSON.parse(localStorage.getItem('ablecon.groups') || '{}') || {}; } catch { /* storage blocked */ }
function rememberGroup(name, open) {
  groupChoice[name] = open;
  try { localStorage.setItem('ablecon.groups', JSON.stringify(groupChoice)); } catch { /* storage blocked */ }
}

/** Turn Live's flat track list into a tree, using each track's group depth. */
function trackTree(tracks) {
  const root = { track: null, children: [] };
  const stack = [root]; // stack[d] = the group that holds tracks at depth d
  for (const t of tracks) {
    const depth = Math.min(t.parents.length, stack.length - 1);
    stack.length = depth + 1;
    const node = { track: t, children: [] };
    stack[depth].children.push(node);
    if (t.isGroup) stack.push(node);
  }
  return root;
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Edit distance with swaps, so "Kign Of Kings" still matches "King Of Kings". */
function closeEnough(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  if (Math.min(a.length, b.length) < 6) return false;
  const d = [];
  for (let i = 0; i <= a.length; i++) { d[i] = [i]; }
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length] <= 2;
}

/** Name of the group that holds the current (or cued) song's stems, if one matches its title. */
function currentGroupName() {
  const row = rowAt(position.beats) || focusRow();
  if (!row || !state) return null;
  const group = (state.tracks || []).find((t) => t.isGroup && closeEnough(t.name, row.name));
  return group ? group.name : null;
}

/** Small M (mute) and S (solo) buttons for one track or group. */
function msButtons(t) {
  return el('span', { class: 'ms' },
    el('button', {
      class: `m${t.muted ? ' on' : ''}`,
      'aria-pressed': String(t.muted),
      'aria-label': `${t.muted ? 'Unmute' : 'Mute'} ${t.name}`,
      title: `${t.muted ? 'Unmute' : 'Mute'} ${t.name}`,
      onclick: (e) => { e.stopPropagation(); send('mute', { track: t.index, name: t.name, muted: !t.muted }); },
    }, 'M'),
    el('button', {
      class: `s${t.soloed ? ' on' : ''}`,
      'aria-pressed': String(!!t.soloed),
      'aria-label': `${t.soloed ? 'Unsolo' : 'Solo'} ${t.name}`,
      title: `${t.soloed ? 'Unsolo' : 'Solo'} ${t.name}`,
      onclick: (e) => { e.stopPropagation(); send('solo', { track: t.index, name: t.name, soloed: !t.soloed }); },
    }, 'S'),
  );
}

/** One track: its name with M and S buttons. */
function trackChip(t) {
  const cls = ['chip'];
  if (t.muted) cls.push('muted');
  if (t.soloed) cls.push('soloed');
  if (!t.muted && !t.soloed && t.mutedViaSolo) cls.push('solo-silent');
  return el('div', {
    class: cls.join(' '),
    title: !t.muted && !t.soloed && t.mutedViaSolo ? `${t.name} is silent because another track is soloed` : t.name,
  }, el('span', { class: 'cname' }, t.name), msButtons(t));
}

function countSoloed(node) {
  return node.children.reduce((n, c) => n + (c.track.soloed ? 1 : 0) + countSoloed(c), 0);
}

function countMuted(node) {
  return node.children.reduce((n, c) => n + (c.track.muted ? 1 : 0) + countMuted(c), 0);
}

let tracksRenderedFor = undefined;
function renderTracks() {
  const box = $('#tracks');
  const tracks = state.tracks || [];
  $('#tracksBtn').textContent = tracksOpen ? 'Hide' : 'Show';
  $('#tracksBtn').setAttribute('aria-expanded', String(tracksOpen));
  box.classList.toggle('collapsed', !tracksOpen);
  $('.mixer').classList.toggle('collapsed', !tracksOpen);
  const current = currentGroupName();
  tracksRenderedFor = current;
  const anySolo = tracks.some((t) => t.soloed);
  $('#clearSolosBtn').classList.toggle('hidden', !anySolo);
  box.replaceChildren();
  if (tracks.length === 0) {
    box.append(el('p', { class: 'hint' }, state.connected ? 'This Live set has no tracks.' : 'Waiting for Live…'));
    return;
  }
  const sectionsName = norm(state.settings.sectionsTrack || '');
  const visible = (node) => !(sectionsName && !node.track.isGroup && norm(node.track.name) === sectionsName);

  const renderLevel = (nodes, container) => {
    const loose = nodes.filter((n) => !n.track.isGroup && visible(n));
    if (loose.length) container.append(el('div', { class: 'chips' }, loose.map((n) => trackChip(n.track))));
    for (const g of nodes.filter((n) => n.track.isGroup)) container.append(groupBlock(g));
  };

  const groupBlock = (node) => {
    const t = node.track;
    const isCurrent = t.name === current;
    const open = groupChoice[t.name] ?? isCurrent;
    const mutedInside = countMuted(node);
    const soloedInside = countSoloed(node);
    const summary = [`${node.children.length} track${node.children.length === 1 ? '' : 's'}`];
    if (mutedInside) summary.push(`${mutedInside} muted`);
    if (soloedInside) summary.push(`${soloedInside} soloed`);
    const block = el('div', { class: `tgroup${isCurrent ? ' current' : ''}${t.muted ? ' muted' : ''}` },
      el('div', { class: 'tgroup-head' },
        el('button', {
          class: 'expander', 'aria-expanded': String(open),
          onclick: () => { rememberGroup(t.name, !open); renderTracks(); },
        },
          el('span', { class: 'caret' }, open ? '▾' : '▸'),
          el('span', { class: 'gname' }, t.name),
          isCurrent ? el('span', { class: 'now' }, 'This song') : null,
          el('span', { class: 'gsum' }, summary.join(' · ')),
        ),
        msButtons(t),
      ),
    );
    if (open) {
      const body = el('div', { class: 'tgroup-body' });
      renderLevel(node.children, body);
      block.append(body);
    }
    return block;
  };

  renderLevel(trackTree(tracks).children, box);
}

/** The Next section button: what it will do, or the countdown to a waiting jump. */
function renderNextSection(here, focus) {
  const btn = $('#nextSectionBtn');
  const pj = state.pendingJump;
  document.querySelectorAll('#sections button').forEach((b) => {
    b.classList.toggle('target', !!pj && focus && pj.songId === focus.songId && Number(b.dataset.i) === pj.sectionIndex);
  });
  if (pj) {
    const left = Math.max(0, Math.ceil(pj.at - position.beats - 1e-6));
    btn.classList.add('pending');
    btn.disabled = false;
    btn.replaceChildren(el('span', {}, `→ ${pj.name} in ${left} beat${left === 1 ? '' : 's'}`), el('span', { class: 'sub' }, 'Tap to cancel'));
    return;
  }
  btn.classList.remove('pending');
  const row = here || focus;
  const i = row ? row.sections.findIndex((s) => position.beats >= s.start && position.beats < s.end) : -1;
  const next = row ? (i >= 0 ? row.sections[i + 1] : row.sections.find((s) => s.start > position.beats)) : null;
  btn.disabled = !next;
  const bars = state.settings.jumpBars ?? 2;
  const when = position.playing ? ` · after ${bars} bar${bars === 1 ? '' : 's'}` : '';
  btn.replaceChildren(el('span', {}, next ? `Next section → ${next.name}` : 'Next section'), next ? el('span', { class: 'sub' }, when.replace(' · ', '')) : null);
}

let sectionsFor = null;
function renderSections() {
  const row = focusRow();
  sectionsFor = row ? row.songId : null;
  const box = $('#sections');
  box.replaceChildren();
  if (!row) return;
  if (row.sections.length === 0) {
    box.append(el('div', { class: 'empty' }, 'This song has no section locators.'));
    return;
  }
  row.sections.forEach((s, i) => {
    box.append(el('button', {
      'data-i': i,
      onclick: () => send(tapMode === 'loop' ? 'loop' : 'section', { songId: row.songId, section: i }),
    }, s.name));
  });
}

// ---- waveform -------------------------------------------------------------------
// The song's stems mixed into one outline (built by the server from the audio
// files), over bands for its sections. The part already played is bright.

const waves = new Map(); // songId -> { version, data } once fetched
const waveFetching = new Set();
let waveLayers = null; // the drawn song, cached until something changes

function sectionColour(name) {
  const n = name.toLowerCase();
  if (/pre[- ]?chorus|pre\b|lift|build/.test(n)) return '#e8c547';
  if (/chorus|refrain/.test(n)) return '#ff8a3d';
  if (/verse/.test(n)) return '#4f9dff';
  if (/bridge/.test(n)) return '#b383ff';
  if (/instrumental|inst\b|interlude|turn|solo|vamp|break/.test(n)) return '#3ccf8e';
  if (/tag|outro|ending|end\b/.test(n)) return '#ff6b8b';
  return '#9aa5b1'; // intro and anything else
}

function wantWave(row) {
  const version = state && state.waveforms ? state.waveforms[row.songId] : null;
  const have = waves.get(row.songId);
  if (!version || (have && have.version === version) || waveFetching.has(row.songId)) return;
  waveFetching.add(row.songId);
  fetch(`/api/waveform?song=${encodeURIComponent(row.songId)}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (data) waves.set(row.songId, { version, data });
      waveLayers = null;
      renderPosition();
    })
    .catch(() => {})
    .finally(() => waveFetching.delete(row.songId));
}

/** Draw the song once (dim and bright copies) into off-screen canvases. */
function waveLayersFor(row, w, h, dpr) {
  const wave = waves.get(row.songId);
  const look = document.documentElement.dataset.look || '';
  const sig = [row.songId, row.start, row.end, wave ? wave.version : '', w, h, dpr, look, row.sections.map((s) => s.name + s.start).join('|'), state.barBeats].join(';');
  if (waveLayers && waveLayers.sig === sig) return waveLayers;
  const css = getComputedStyle(document.documentElement);
  const text = css.getPropertyValue('--text').trim() || '#fff';
  const span = row.end - row.start;
  const x = (beat) => ((beat - row.start) / span) * w;
  const make = (bright) => {
    const c = document.createElement('canvas');
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    // Section bands
    const sections = row.sections.length ? row.sections : [{ name: '', start: row.start, end: row.end }];
    for (const s of sections) {
      g.globalAlpha = bright ? 0.22 : 0.12;
      g.fillStyle = sectionColour(s.name);
      g.fillRect(x(s.start), 0, x(s.end) - x(s.start), h);
    }
    // Bar lines (only when they are far enough apart to read)
    const bar = state.barBeats || 4;
    if ((bar / span) * w >= 5) {
      g.globalAlpha = 0.08;
      g.fillStyle = text;
      for (let b = row.start + bar; b < row.end; b += bar) g.fillRect(Math.round(x(b)), 0, 1, h);
    }
    // The waveform, mirrored about the middle, one column per pixel
    const top = 16; // room for the section names
    const mid = top + (h - top) / 2;
    const half = (h - top) / 2 - 2;
    if (wave) {
      const { peaks, perBeat, start } = wave.data;
      for (const s of sections) {
        g.fillStyle = sectionColour(s.name);
        g.globalAlpha = bright ? 0.95 : 0.4;
        const x0 = Math.max(0, Math.floor(x(s.start)));
        const x1 = Math.min(w, Math.ceil(x(s.end)));
        for (let px = x0; px < x1; px++) {
          const b0 = row.start + (px / w) * span;
          const b1 = row.start + ((px + 1) / w) * span;
          if (b1 <= s.start || b0 >= s.end) continue;
          let peak = 0;
          const i0 = Math.max(0, Math.floor((Math.max(b0, s.start) - start) * perBeat));
          const i1 = Math.min(peaks.length, Math.max(i0 + 1, Math.ceil((Math.min(b1, s.end) - start) * perBeat)));
          for (let i = i0; i < i1; i++) if (peaks[i] > peak) peak = peaks[i];
          const amp = Math.max(0.5, (peak / 255) * half);
          g.fillRect(px, mid - amp, 1, amp * 2);
        }
      }
    } else {
      g.globalAlpha = bright ? 0.9 : 0.35;
      g.fillStyle = text;
      g.fillRect(0, mid - 1, w, 2);
    }
    // Section starts and names
    g.globalAlpha = 1;
    g.font = '600 11px system-ui, -apple-system, sans-serif';
    g.textBaseline = 'top';
    for (const s of row.sections) {
      const sx = x(s.start);
      g.fillStyle = sectionColour(s.name);
      g.globalAlpha = 0.9;
      g.fillRect(Math.round(sx), 0, 2, h);
      const room = x(s.end) - sx - 6;
      if (room > 14) {
        g.globalAlpha = bright ? 1 : 0.75;
        g.fillStyle = text;
        let label = s.name;
        while (label.length > 1 && g.measureText(label).width > room) label = label.slice(0, -1);
        if (label !== s.name) label = label.slice(0, -1) + '…';
        g.fillText(label, sx + 5, 3);
      }
    }
    return c;
  };
  waveLayers = { sig, dim: make(false), bright: make(true) };
  return waveLayers;
}

function drawWave(row, beats) {
  const canvas = $('#waveCanvas');
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const g = canvas.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, canvas.width, canvas.height);
  canvas.dataset.song = row ? row.songId : '';
  canvas.dataset.wave = row && waves.has(row.songId) ? 'yes' : 'no';
  if (!row || w === 0 || h === 0) return;
  wantWave(row);
  const layers = waveLayersFor(row, w, h, dpr);
  g.drawImage(layers.dim, 0, 0);
  if (beats === null) return;
  const px = Math.max(0, Math.min(1, (beats - row.start) / (row.end - row.start))) * canvas.width;
  if (px > 0) g.drawImage(layers.bright, 0, 0, px, canvas.height, 0, 0, px, canvas.height);
  const css = getComputedStyle(document.documentElement);
  g.fillStyle = css.getPropertyValue('--text').trim() || '#fff';
  g.fillRect(Math.round(px - dpr), 0, Math.max(2, Math.round(2 * dpr)), canvas.height);
}

window.addEventListener('resize', () => renderPosition());

function renderPosition() {
  if (!state) return;
  const here = rowAt(position.beats);
  const focus = focusRow();
  if ((focus ? focus.songId : null) !== sectionsFor) renderSections();
  if (currentGroupName() !== tracksRenderedFor) renderTracks();

  const playBtn = $('#playBtn');
  playBtn.classList.toggle('active', position.playing);

  if (focus) {
    const inside = here && here.songId === focus.songId;
    $('#nowLabel').textContent = inside ? (position.playing ? 'Playing' : 'Ready at') : 'Ready';
    $('#nowTitle').textContent = focus.name;
    const bpm = focus.tempo ?? position.tempo;
    const elapsedBeats = inside ? position.beats - focus.start : 0;
    const total = (focus.end - focus.start) * 60 / (inside ? position.tempo : bpm);
    const elapsed = elapsedBeats * 60 / (inside ? position.tempo : bpm);
    $('#elapsed').textContent = clock(elapsed);
    $('#remaining').textContent = '–' + clock(total - elapsed);
    drawWave(focus, inside ? position.beats : null);
    const secIdx = inside ? focus.sections.findIndex((s) => position.beats >= s.start && position.beats < s.end) : -1;
    $('#nowSection').textContent = secIdx >= 0 ? focus.sections[secIdx].name : '';
    $('#nowTempo').textContent = bpmText(position.tempo);
    const label = keyLabel(focus);
    $('#nowKey').textContent = label && focus.originalKey ? `Key ${label}` : label;
    document.querySelectorAll('#sections button').forEach((b) => {
      const s = focus.sections[Number(b.dataset.i)];
      b.classList.toggle('here', Number(b.dataset.i) === secIdx);
      const looping = position.loop.enabled && Math.abs(position.loop.start - s.start) < 1e-3 && Math.abs(position.loop.length - (s.end - s.start)) < 1e-3;
      b.classList.toggle('looping', looping);
    });
  } else {
    $('#nowLabel').textContent = 'Not in a song';
    $('#nowTitle').textContent = '–';
    $('#nowSection').textContent = '';
    drawWave(null, null);
  }
  $('#loopOffBtn').classList.toggle('hidden', !position.loop.enabled);
  renderNextSection(here, focus);

  document.querySelectorAll('#setlist .song').forEach((li) => li.classList.toggle('current', !!here && li.dataset.id === here.songId));

  let upNext = null;
  let how = '';
  if (here) {
    const flow = here.stopAtEnd ? null : playable().find((r) => Math.abs(r.start - here.end) < 1e-6) || null;
    if (state.cuedId && state.cuedId !== here.songId) {
      upNext = rowById(state.cuedId);
      how = flow && flow.songId === state.cuedId ? ' · plays straight on' : here.stopAtEnd ? ' · after the STOP' : ' · jumps there at the end of this song';
    } else if (flow) {
      upNext = flow;
      how = ' · plays straight on';
    } else {
      upNext = nextAfter(here.songId);
      how = here.stopAtEnd ? ' · after the STOP' : '';
    }
  }
  $('#upNext').replaceChildren(...(upNext ? ['Up next: ', el('strong', {}, upNext.name), how] : []));
  $('#nextBtn').disabled = !nextAfter((here || focus || {}).songId);
}

// ---- controls ------------------------------------------------------------------

$('#playBtn').onclick = () => send('play');
$('#stopBtn').onclick = () => send('stop');
$('#nextBtn').onclick = () => {
  const base = rowAt(position.beats) || focusRow();
  const next = base && nextAfter(base.songId);
  if (next) send('cue', { songId: next.songId });
};
$('#loopOffBtn').onclick = () => send('loopOff');
$('#nextSectionBtn').onclick = () => send(state && state.pendingJump ? 'cancelJump' : 'nextSection');
$('#clearSolosBtn').onclick = () => send('clearSolos');
$('#tracksBtn').onclick = () => {
  tracksOpen = !tracksOpen;
  try { localStorage.setItem('ablecon.tracksOpen', tracksOpen ? 'yes' : 'no'); } catch { /* storage blocked */ }
  renderTracks();
};
$('#editBtn').onclick = () => {
  editing = !editing;
  $('#editBtn').textContent = editing ? 'Done' : 'Edit';
  renderSetlist();
};
document.querySelectorAll('.sections-head .seg button').forEach((b) => {
  b.onclick = () => {
    tapMode = b.dataset.mode;
    document.querySelectorAll('.sections-head .seg button').forEach((o) => o.classList.toggle('on', o === b));
  };
});
$('#settingsBtn').onclick = async () => {
  $('#settings').showModal();
  try {
    const urls = await (await fetch('/api/urls')).json();
    $('#urls').textContent = `Open on other devices: ${urls.join('  ·  ')}`;
  } catch { /* offline */ }
};
function setLook(look) {
  if (look === 'stage') delete document.documentElement.dataset.look;
  else document.documentElement.dataset.look = look;
  try { localStorage.setItem('ablecon.look', look); } catch { /* storage blocked */ }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
}
$('#look').value = document.documentElement.dataset.look || 'stage';
$('#look').onchange = (e) => setLook(e.target.value);

$('#endOfSong').onchange = (e) => send('settings', { settings: { endOfSong: e.target.value } });
$('#jumpBars').onchange = (e) => send('settings', { settings: { jumpBars: Number(e.target.value) } });
$('#noKeyTag').onchange = (e) => send('settings', { settings: { noKeyTag: e.target.value } });
$('#sectionsTrack').onchange = (e) => send('settings', { settings: { sectionsTrack: e.target.value } });
$('#rescanBtn').onclick = () => send('refresh');

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if (e.code === 'Space') { e.preventDefault(); send(position.playing ? 'stop' : 'play'); }
});

connect();
