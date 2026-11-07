// Ablcon web UI. Plain JavaScript, no build step.
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
try { tracksOpen = localStorage.getItem('ablcon.tracksOpen') !== 'no'; } catch { /* storage blocked */ }

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
    toast('Not connected to the Ablcon server.', 'error');
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
  if (row.tempo !== null) tags.push(el('span', { class: 'tag' }, bpmText(row.tempo)));
  const keyTag = keyLabel(row);
  if (keyTag) tags.push(el('span', { class: 'tag', title: row.semitones ? `${keyText(row.semitones)} semitones` : 'Original key' }, keyTag));
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

  const edit = el('div', { class: 'edit' },
    el('button', { class: 'small', disabled: i === 0, 'aria-label': 'Move up', onclick: () => send('move', { from: i, to: i - 1 }) }, '↑'),
    el('button', { class: 'small', disabled: i === state.rows.length - 1, 'aria-label': 'Move down', onclick: () => send('move', { from: i, to: i + 1 }) }, '↓'),
    el('label', {}, 'Tempo',
      el('input', {
        type: 'number', inputmode: 'decimal', min: 20, max: 999, step: 'any', placeholder: 'as set',
        value: row.tempo ?? '',
        onchange: (e) => send('tempo', { songId: row.songId, tempo: e.target.value }),
        onblur: () => renderDeferred && setTimeout(renderSetlist, 0),
      })),
    row.missing ? null : keyStepper(row),
    row.missing ? el('button', { class: 'small', onclick: () => send('remove', { songId: row.songId }) }, 'Remove') : null,
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
    el('button', { class: 'small', disabled: value !== null && value <= -12, onclick: () => set((value ?? 0) - 1), 'aria-label': 'Key down' }, '−'),
    el('output', {}, value === null ? 'off' : row.originalKey ? `${keyText(value)} (${row.playedKey})` : keyText(value)),
    el('button', { class: 'small', disabled: value !== null && value >= 12, onclick: () => set((value ?? 0) + 1), 'aria-label': 'Key up' }, '+'),
    value === null ? null : el('button', { class: 'small ghost', onclick: () => set(null), title: 'Stop managing the key of this song' }, 'Off'),
    value === null ? null : el('button', { class: 'small', onclick: () => send('applyKey', { songId: row.songId }) }, 'Apply'),
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
try { groupChoice = JSON.parse(localStorage.getItem('ablcon.groups') || '{}') || {}; } catch { /* storage blocked */ }
function rememberGroup(name, open) {
  groupChoice[name] = open;
  try { localStorage.setItem('ablcon.groups', JSON.stringify(groupChoice)); } catch { /* storage blocked */ }
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
    $('#barFill').style.width = `${Math.min(100, (elapsedBeats / (focus.end - focus.start)) * 100)}%`;
    $('#barMarks').replaceChildren(...focus.sections.slice(1).map((s) => {
      const m = el('span');
      m.style.left = `${((s.start - focus.start) / (focus.end - focus.start)) * 100}%`;
      return m;
    }));
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
    $('#barFill').style.width = '0';
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
  try { localStorage.setItem('ablcon.tracksOpen', tracksOpen ? 'yes' : 'no'); } catch { /* storage blocked */ }
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
