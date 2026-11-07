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
  if (document.activeElement !== $('#noKeyTag')) $('#noKeyTag').value = state.settings.noKeyTag;

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
  if (row.semitones !== null && row.semitones !== 0) tags.push(el('span', { class: 'tag' }, `Key ${keyText(row.semitones)}`));
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
    el('output', {}, value === null ? 'off' : keyText(value)),
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

function renderTracks() {
  const box = $('#tracks');
  const tracks = state.tracks || [];
  $('#tracksBtn').textContent = tracksOpen ? 'Hide' : 'Show';
  $('#tracksBtn').setAttribute('aria-expanded', String(tracksOpen));
  box.classList.toggle('collapsed', !tracksOpen);
  $('.mixer').classList.toggle('collapsed', !tracksOpen);
  box.replaceChildren();
  if (tracks.length === 0) {
    box.append(el('p', { class: 'hint' }, state.connected ? 'This Live set has no tracks.' : 'Waiting for Live…'));
    return;
  }
  for (const t of tracks) {
    const cls = ['track'];
    if (t.isGroup) cls.push('group');
    if (t.muted) cls.push('muted');
    const btn = el('button', {
      class: cls.join(' '),
      'aria-pressed': String(t.muted),
      title: t.muted ? `Unmute ${t.name}` : `Mute ${t.name}`,
      onclick: () => send('mute', { track: t.index, name: t.name, muted: !t.muted }),
    },
      el('span', { class: 'tname' }, t.name),
      !t.muted && t.mutedViaSolo ? el('span', { class: 'why' }, 'silent: another track is soloed') : null,
      el('span', { class: 'state' }, t.muted ? 'Muted' : 'On'),
    );
    btn.style.marginLeft = `${t.parents.length * 18}px`;
    btn.style.width = `calc(100% - ${t.parents.length * 18}px)`;
    box.append(btn);
  }
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
    $('#nowKey').textContent = focus.semitones ? `Key ${keyText(focus.semitones)}` : '';
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

  document.querySelectorAll('#setlist .song').forEach((li) => li.classList.toggle('current', !!here && li.dataset.id === here.songId));

  const upNext = here ? (state.cuedId && state.cuedId !== here.songId ? rowById(state.cuedId) : nextAfter(here.songId)) : null;
  $('#upNext').replaceChildren(...(upNext ? ['Up next: ', el('strong', {}, upNext.name)] : []));
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
document.querySelectorAll('.seg button').forEach((b) => {
  b.onclick = () => {
    tapMode = b.dataset.mode;
    document.querySelectorAll('.seg button').forEach((o) => o.classList.toggle('on', o === b));
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
$('#noKeyTag').onchange = (e) => send('settings', { settings: { noKeyTag: e.target.value } });
$('#rescanBtn').onclick = () => send('refresh');

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if (e.code === 'Space') { e.preventDefault(); send(position.playing ? 'stop' : 'play'); }
});

connect();
