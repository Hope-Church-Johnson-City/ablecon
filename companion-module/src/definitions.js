// Actions, feedbacks and ready-made buttons (presets) the module offers in
// Companion. Each action sends one Ablecon command (see logic.js).

import { combineRgb } from '@companion-module/base';
import { MAX_SECTIONS, MAX_SONGS, checks } from './logic.js';

const WHITE = combineRgb(255, 255, 255);
const BLACK = combineRgb(0, 0, 0);
const GREY = combineRgb(40, 40, 40);
const GREEN = combineRgb(46, 160, 67);
const RED = combineRgb(200, 50, 45);
const ORANGE = combineRgb(255, 158, 61);
const YELLOW = combineRgb(242, 216, 75);
const BLUE = combineRgb(40, 110, 200);

const numberOption = (label, max) => ({ type: 'number', id: 'number', label, default: 1, min: 1, max, asInteger: true });
const trackOptions = [
  { type: 'textinput', id: 'name', label: 'Track name (as in Live)', default: '' },
  { type: 'textinput', id: 'group', label: "Group name (only if the name isn't unique)", default: '' },
];
const modeOption = (verb) => ({
  type: 'dropdown',
  id: 'mode',
  label: 'What to do',
  default: 'toggle',
  choices: [
    { id: 'toggle', label: `Toggle ${verb}` },
    { id: 'on', label: `${verb[0].toUpperCase()}${verb.slice(1)}` },
    { id: 'off', label: `Un${verb}` },
  ],
});

/** @param {(actionId: string, options: object) => Promise<void>} run */
export function actionDefinitions(run) {
  const a = (name, options, description) => ({ name, description, options, callback: (ev) => run(ev.actionId, ev.options) });
  return {
    play: a('Play', [], 'Play from where the playhead is (the cued song or section)'),
    stop: a('Stop', [], 'Stop. Pressed again while stopped: back to the start of the song'),
    toggle_play: a('Play / Stop', []),
    next_song: a('Next song', [], 'Get the next song in the setlist ready (queued if playing)'),
    previous_song: a('Previous song', []),
    cue_song: a('Cue song number', [numberOption('Song number in the setlist', MAX_SONGS)], 'Get this song ready (queued if playing)'),
    start_song: a('Play song number', [numberOption('Song number in the setlist', MAX_SONGS)], 'Jump to this song and play it now'),
    next_section: a('Next section (waits for the bar line)', [
      { type: 'checkbox', id: 'tapToCancel', label: 'Pressing again while waiting cancels', default: true },
    ], 'Jumps to the next section on the bar line set in Ablecon (2 bars by default)'),
    cancel_jump: a('Cancel next-section jump', []),
    jump_section: a('Jump to section number', [numberOption('Section number in the current song', MAX_SECTIONS)], 'Jumps straight away'),
    loop_section: a('Loop section number (toggle)', [numberOption('Section number in the current song', MAX_SECTIONS)]),
    loop_off: a('Loop off', []),
    mute_track: a('Mute track', [...trackOptions, modeOption('mute')]),
    solo_track: a('Solo track', [...trackOptions, modeOption('solo')]),
    clear_solos: a('Clear solos', []),
    reread: a('Re-read locators and tempos', []),
  };
}

/** @param {(feedbackId: string, options: object) => boolean} check */
export function feedbackDefinitions(check) {
  const f = (name, options, defaultStyle, description) => ({
    type: 'boolean',
    name,
    description,
    options,
    defaultStyle,
    callback: (ev) => check(ev.feedbackId, ev.options),
  });
  const defs = {
    playing: f('Live is playing', [], { bgcolor: GREEN, color: WHITE }),
    live_connected: f('Connected to Live', [], { bgcolor: GREEN, color: WHITE }, 'True when Ablecon is running and talking to Live'),
    song_active: f('Song number is playing or ready', [numberOption('Song number', MAX_SONGS)], { bgcolor: GREEN, color: WHITE }),
    song_up_next: f('Song number is up next', [numberOption('Song number', MAX_SONGS)], { bgcolor: ORANGE, color: BLACK }),
    section_active: f('Playhead is in section number', [numberOption('Section number', MAX_SECTIONS)], { bgcolor: ORANGE, color: BLACK }),
    section_looping: f('Section number is looping', [numberOption('Section number', MAX_SECTIONS)], { bgcolor: BLUE, color: WHITE }),
    jump_pending: f('Next-section jump is waiting', [], { bgcolor: YELLOW, color: BLACK }),
    track_muted: f('Track is muted', trackOptions, { bgcolor: RED, color: WHITE }),
    track_soloed: f('Track is soloed', trackOptions, { bgcolor: YELLOW, color: BLACK }),
    any_solo: f('Any track is soloed', [], { bgcolor: YELLOW, color: BLACK }),
  };
  for (const id of Object.keys(defs)) if (!checks[id]) throw new Error(`no check for feedback ${id}`);
  return defs;
}

// ---- ready-made buttons ----------------------------------------------------------------

function button(name, text, actionId, options = {}, feedbacks = [], style = {}) {
  return {
    type: 'simple',
    name,
    style: { text, size: 'auto', color: WHITE, bgcolor: GREY, ...style },
    steps: [{ down: actionId ? [{ actionId, options }] : [], up: [] }],
    feedbacks,
  };
}

/** @param {string} label the connection's label, used in $(label:variable) */
export function presetDefinitions(label) {
  const v = (name) => `$(${label}:${name})`;
  const presets = {};
  const transport = [];
  const add = (list, id, preset) => {
    presets[id] = preset;
    list.push(id);
  };

  add(transport, 'play_stop', button('Play / Stop', '▶ PLAY', 'toggle_play', {}, [
    { feedbackId: 'playing', options: {}, style: { text: '■ STOP', bgcolor: GREEN, color: WHITE } },
  ]));
  add(transport, 'play', button('Play', '▶', 'play', {}, [{ feedbackId: 'playing', options: {}, style: { bgcolor: GREEN } }], { size: '30' }));
  add(transport, 'stop', button('Stop', '■', 'stop', {}, [], { size: '30', bgcolor: combineRgb(90, 30, 28) }));
  add(transport, 'previous_song', button('Previous song', '⏮ PREV SONG', 'previous_song'));
  add(transport, 'next_song', button('Next song', `NEXT SONG\\n${v('up_next')}`, 'next_song'));
  add(transport, 'next_section', button('Next section (waits for the bar line)', `NEXT ▸\\n${v('next_section_name')}`, 'next_section', { tapToCancel: true }, [
    { feedbackId: 'jump_pending', options: {}, style: { text: `→ ${v('jump_countdown')}`, bgcolor: YELLOW, color: BLACK } },
  ]));
  add(transport, 'loop_off', button('Loop off', 'LOOP OFF', 'loop_off'));
  add(transport, 'clear_solos', button('Clear solos', 'CLEAR SOLOS', 'clear_solos', {}, [
    { feedbackId: 'any_solo', options: {}, style: { bgcolor: YELLOW, color: BLACK } },
  ]));

  const info = [];
  add(info, 'now_playing', button('Now playing (display)', `${v('song_name')}\\n${v('section_name')}\\n${v('remaining')}`, null, {}, [
    { feedbackId: 'playing', options: {}, style: { bgcolor: GREEN } },
  ], { size: '14' }));
  add(info, 'song_info', button('Key and tempo (display)', `${v('song_key')}\\n${v('song_tempo')} BPM`, null));
  add(info, 'set_length', button('Set length (display)', `SET\\n${v('set_length')}`, null));
  add(info, 'live_link', button('Live connection (display)', 'LIVE\\nOFFLINE', null, {}, [
    { feedbackId: 'live_connected', options: {}, style: { text: 'LIVE\\nOK', bgcolor: GREEN } },
  ], { bgcolor: RED }));

  const setlist = [];
  for (let i = 1; i <= 12; i++) {
    add(setlist, `song_${i}`, button(`Song ${i}`, `${i}\\n${v(`song_${i}`)}`, 'cue_song', { number: i }, [
      { feedbackId: 'song_active', options: { number: i }, style: { bgcolor: GREEN, color: WHITE } },
      { feedbackId: 'song_up_next', options: { number: i }, style: { bgcolor: ORANGE, color: BLACK } },
    ], { size: '14' }));
  }

  const sections = [];
  for (let i = 1; i <= 16; i++) {
    add(sections, `section_${i}`, button(`Section ${i}`, v(`section_${i}`), 'jump_section', { number: i }, [
      { feedbackId: 'section_active', options: { number: i }, style: { bgcolor: ORANGE, color: BLACK } },
      { feedbackId: 'section_looping', options: { number: i }, style: { bgcolor: BLUE, color: WHITE } },
    ], { size: '14' }));
  }

  const tracks = [];
  const mute = (id, name, track) => add(tracks, id, button(name, `MUTE\\n${track}`, 'mute_track', { name: track, group: '', mode: 'toggle' }, [
    { feedbackId: 'track_muted', options: { name: track, group: '' }, style: { bgcolor: RED, color: WHITE } },
  ], { size: '14' }));
  mute('mute_click', 'Mute click (edit the track name)', 'Click Foundations');
  mute('mute_guide', 'Mute guide (edit the track name)', 'Guide');

  const structure = [
    { id: 'transport', name: 'Transport', definitions: transport },
    { id: 'setlist', name: 'Setlist (songs 1–12)', definitions: setlist },
    { id: 'sections', name: 'Sections of the current song', definitions: sections },
    { id: 'info', name: 'Displays', definitions: info },
    { id: 'tracks', name: 'Tracks', definitions: tracks },
  ];
  return { structure, presets };
}
