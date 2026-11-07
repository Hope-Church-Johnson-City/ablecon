// LiveClient and Controller against a fake Live over real UDP sockets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { once } from 'node:events';
import dgram from 'node:dgram';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LiveClient } from '../src/liveClient.ts';
import { Controller } from '../src/controller.ts';
import type { Position } from '../src/types.ts';
import { FakeLive, demoSet } from './fakeLive.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(10);
  }
}

async function setup(opts: { timeoutMs?: number } = {}) {
  const fake = new FakeLive(demoSet());
  const port = await fake.start();
  const client = new LiveClient({ port, timeoutMs: opts.timeoutMs ?? 500, heartbeatMs: 60_000 });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ablecon-'));
  const setlistPath = path.join(dir, 'setlist.json');
  const controller = new Controller(client, setlistPath);
  controller.scanSettleMs = 5;
  await controller.init();
  const done = () => {
    client.stop();
    fake.close();
  };
  return { fake, client, controller, setlistPath, done };
}

test('client calls methods and gets results and errors', async () => {
  const { fake, client, done } = await setup();
  try {
    await client.start();
    await until(() => client.connected);
    assert.equal(client.liveVersion, '12.0.0');
    await client.call('jump', { beats: 12.5 });
    assert.equal(fake.set.beats, 12.5);
    await assert.rejects(client.call('explode'), /boom/);
  } finally {
    done();
  }
});

test('client reassembles chunked replies, even out of order', async () => {
  const { fake, client, done } = await setup();
  try {
    fake.chunkSize = 50;
    fake.set.cues = Array.from({ length: 100 }, (_, i) => ({ name: `Section ${i} ✓`, time: i }));
    await client.start();
    const reply = await client.call<{ cues: unknown[] }>('cues');
    assert.equal(reply.cues.length, 100);
  } finally {
    done();
  }
});

test('client times out when Live does not answer and reports disconnection', async () => {
  const { fake, client, done } = await setup({ timeoutMs: 100 });
  try {
    fake.silent = true;
    const events: boolean[] = [];
    client.on('connection', (up) => events.push(up));
    await client.start();
    await assert.rejects(client.call('state'), /did not answer/);
    assert.equal(client.connected, false);
    fake.silent = false;
    await client.call('state');
  } finally {
    done();
  }
});

test('client emits pushed positions and change notices', async () => {
  const { fake, client, done } = await setup();
  try {
    await client.start();
    await until(() => client.connected);
    fake.set.beats = 17.25;
    fake.set.playing = true;
    const got = once(client, 'position');
    fake.pushPosition();
    const [p] = (await got) as [Position];
    assert.deepEqual(p, { beats: 17.25, playing: true, tempo: 120, loop: { enabled: false, start: 0, length: 4 } });
    const changed = once(client, 'changed');
    fake.pushChanged('cues');
    assert.deepEqual(await changed, ['cues']);
  } finally {
    done();
  }
});

test('controller builds the setlist from locators and saves it', async () => {
  const { controller, client, setlistPath, done } = await setup();
  try {
    await client.start();
    await until(() => controller.songs.length === 2);
    const snap = controller.snapshot();
    assert.deepEqual(snap.rows.map((r) => r.name), ['First', 'Second']);
    assert.equal(snap.totalSeconds, 32 * 0.5 + 32 * 0.5);
    await controller.move(1, 0);
    const saved = JSON.parse(await readFile(setlistPath, 'utf8'));
    assert.equal(saved.version, 2);
    assert.deepEqual(saved.sets.map((s: { songIds: string[] }) => s.songIds), [['second', 'first']]);
  } finally {
    done();
  }
});

test('opening a different Live set shows its own setlist; reopening brings the first back', async () => {
  const { fake, controller, client, done } = await setup();
  try {
    await client.start();
    await until(() => controller.songs.length === 2);
    await controller.move(1, 0); // this week's order: Second, First
    await controller.setKey('first', 3);
    // Open next week's set in Live (different songs, plus First again).
    fake.set.cues = [{ name: 'Fresh', time: 0 }, { name: 'First', time: 16 }, { name: 'Other', time: 32 }, { name: 'STOP', time: 48 }];
    fake.pushChanged('cues');
    await until(() => controller.songs.some((s) => s.name === 'Fresh'));
    await until(() => controller.snapshot().rows.length === 3);
    assert.deepEqual(controller.snapshot().rows.map((r) => r.name), ['Fresh', 'First', 'Other']);
    assert.equal(controller.snapshot().rows[1].semitones, 3, "First's key came along");
    // Back to the first set.
    fake.set.cues = demoSet().cues;
    fake.pushChanged('cues');
    await until(() => controller.snapshot().rows.length === 2 && controller.snapshot().rows[0].name === 'Second');
    assert.deepEqual(controller.snapshot().rows.map((r) => r.name), ['Second', 'First']);
  } finally {
    done();
  }
});

test('cueing a stopped song sets tempo, key and playhead', async () => {
  const { fake, controller, client, done } = await setup();
  try {
    await client.start();
    await until(() => controller.songs.length === 2);
    await controller.setTempo('second', 72);
    await controller.setKey('second', -3);
    await controller.cue('second');
    assert.equal(fake.set.tempo, 72);
    assert.equal(fake.set.beats, 40);
    assert.equal(fake.set.tracks[1].clips[1].pitch, -3, 'Keys clip in song 2');
    assert.equal(fake.set.tracks[1].clips[0].pitch, 0, 'Keys clip in song 1 untouched');
    assert.equal(fake.set.tracks[0].clips[0].pitch, 0, '[nokey] click untouched');
    assert.equal(fake.set.tracks[2].pitchDevices[0].params[1].value, -3, 'Pitch device');
    assert.equal(controller.keyStatus.get('second')?.semitones, -3);
    assert.equal(fake.set.playing, false);
    await controller.start('second', 1);
    assert.equal(fake.set.beats, 56);
    assert.equal(fake.set.playing, true);
  } finally {
    done();
  }
});

test('while playing, a queued song only gets safe changes; the rest waits for stop', async () => {
  const { fake, controller, client, done } = await setup();
  try {
    await client.start();
    await until(() => controller.songs.length === 2);
    await controller.setKey('second', 4);
    await controller.setTempo('second', 90);
    fake.set.playing = true;
    fake.set.beats = 8; // inside "First"
    fake.pushPosition();
    await until(() => controller.position.playing);
    await controller.cue('second');
    assert.equal(fake.set.tracks[1].clips[1].pitch, 4, 'clips of the other song change right away');
    assert.equal(fake.set.tracks[2].pitchDevices[0].params[1].value, 0, 'Pitch device waits');
    assert.equal(fake.set.tempo, 120, 'tempo waits until the song starts');
    assert.equal(fake.set.beats, 8, 'playhead not moved');
    assert.equal(controller.keyStatus.get('second')?.pending, true);

    fake.set.playing = false;
    fake.pushPosition();
    await until(() => fake.set.tracks[2].pitchDevices[0].params[1].value === 4);
    await until(() => controller.keyStatus.get('second')?.pending === false);
  } finally {
    done();
  }
});

test('at the end of a song Live stops and the next song is cued', async () => {
  const { fake, controller, client, done } = await setup();
  try {
    await client.start();
    await until(() => controller.songs.length === 2);
    await controller.setTempo('second', 100);
    fake.set.playing = true;
    fake.set.beats = 31.9;
    fake.pushPosition();
    await until(() => controller.position.beats > 31);
    fake.set.beats = 32.05;
    fake.pushPosition();
    await until(() => fake.set.beats === 40);
    assert.equal(fake.set.playing, false);
    assert.equal(fake.set.tempo, 100);
    assert.equal(controller.cuedId, 'second');
  } finally {
    done();
  }
});

test('a song without a STOP plays straight into the next one, with its tempo and key ready', async () => {
  const { fake, controller, client, done } = await setup();
  try {
    // First (0-32) runs into Second (32-64) with no STOP between them.
    fake.set.cues = [{ name: 'First', time: 0 }, { name: 'Second (G)', time: 32 }, { name: 'STOP', time: 64 }];
    fake.set.tracks[1].clips[1] = { ...fake.set.tracks[1].clips[1], start: 32, end: 64 };
    await client.start();
    await until(() => controller.songs.length === 2);
    assert.deepEqual(controller.songs.map((s) => s.stopAtEnd), [false, true]);
    await controller.setTempo('second', 90);
    await controller.setKey('second', 2);
    await controller.start('first');
    assert.equal(fake.set.tracks[1].clips[1].pitch, 2, "Second's stems transposed before it plays");
    assert.equal(fake.set.tracks[1].clips[0].pitch, 0);
    assert.equal(fake.set.tracks[2].pitchDevices[0].params[1].value, 0, 'Pitch devices wait');
    assert.equal(fake.set.tempo, 120);

    fake.set.beats = 31.9;
    fake.pushPosition();
    await until(() => controller.position.beats > 31);
    const calls = fake.calls.length;
    fake.set.beats = 32.05;
    fake.pushPosition();
    await until(() => fake.set.tempo === 90);
    assert.equal(fake.set.playing, true, 'still playing');
    assert.ok(!fake.methods().slice(calls).includes('stop'));
    assert.ok(!fake.methods().slice(calls).includes('jump'), 'no jump either');
    assert.equal(controller.cuedId, 'second');

    // ...and Second ends at a STOP, so Live stops there.
    fake.set.beats = 63.9;
    fake.pushPosition();
    await until(() => controller.position.beats > 63);
    fake.set.beats = 64.05;
    fake.pushPosition();
    await until(() => fake.set.playing === false);
  } finally {
    done();
  }
});

test('a queued song wins at a STOP-less boundary and playback jumps to it', async () => {
  const { fake, controller, client, done } = await setup();
  try {
    fake.set.cues = [{ name: 'First', time: 0 }, { name: 'Second', time: 32 }, { name: 'Third', time: 64 }, { name: 'STOP', time: 96 }];
    await client.start();
    await until(() => controller.songs.length === 3);
    await controller.start('first');
    await controller.cue('third');
    fake.set.beats = 31.9;
    fake.pushPosition();
    await until(() => controller.position.beats > 31);
    fake.set.beats = 32.05;
    fake.pushPosition();
    await until(() => fake.set.beats === 64);
    assert.equal(fake.set.playing, true);
  } finally {
    done();
  }
});

test('Play after tapping a song plays that song, not from Live\'s insert marker', async () => {
  const { fake, controller, client, done } = await setup();
  try {
    await client.start();
    await until(() => controller.songs.length === 2);
    fake.startMarker = 0; // Live's start marker at the top of the set, as in the bug report
    fake.stopPosition = 9; // and it last stopped somewhere in the first song
    await controller.cue('second');
    assert.equal(fake.set.beats, 40);
    await controller.play();
    assert.equal(fake.set.playing, true);
    assert.equal(fake.set.beats, 40, 'still at Second, not back at bar 1');
    await controller.markStoppedForTest();
    await controller.start('first', 1);
    assert.equal(fake.set.beats, 16);
    assert.equal(fake.set.playing, true);
  } finally {
    done();
  }
});

test('with an old Remote Script, Play still lands on the song (start, then jump)', async () => {
  const { fake, controller, client, done } = await setup();
  try {
    fake.oldScript = true;
    fake.stopPosition = 9;
    await client.start();
    await until(() => controller.songs.length === 2);
    const notices: string[] = [];
    controller.on('notice', (n) => notices.push(n.text));
    await controller.cue('second');
    await controller.play();
    assert.equal(fake.set.playing, true);
    assert.equal(fake.set.beats, 40);
    const m = fake.methods();
    assert.deepEqual(m.slice(m.lastIndexOf('play_from')), ['play_from', 'continue', 'jump']);
    assert.match(notices.join(), /Update the Remote Script/);
  } finally {
    done();
  }
});

test('Stop gets a song that was queued while playing ready', async () => {
  const { fake, controller, client, done } = await setup();
  try {
    await client.start();
    await until(() => controller.songs.length === 2);
    await controller.setTempo('second', 90);
    await controller.start('first');
    fake.set.beats = 6;
    fake.pushPosition();
    await until(() => controller.position.beats === 6);
    await controller.cue('second'); // queued: nothing moves yet
    assert.equal(fake.set.beats, 6);
    await controller.stop();
    assert.equal(fake.set.playing, false);
    assert.equal(fake.set.beats, 40, 'playhead moved to the queued song');
    assert.equal(fake.set.tempo, 90);
  } finally {
    done();
  }
});

test('running times use the tempo Live plays each song at', async () => {
  const { fake, controller, client, done } = await setup();
  try {
    await client.start();
    await until(() => controller.songs.length === 2);
    // Tempo automation: Second plays at 60, First at 120.
    fake.set.beats = 41;
    fake.set.tempo = 60;
    fake.pushPosition();
    await until(() => controller.file.entries.find((e) => e.songId === 'second')?.seenTempo === 60);
    fake.set.beats = 1;
    fake.set.tempo = 120;
    fake.pushPosition();
    await until(() => controller.file.entries.find((e) => e.songId === 'first')?.seenTempo === 120);
    const total = controller.snapshot().totalSeconds;
    assert.equal(total, 32 * 0.5 + 32 * 1); // First 32 beats at 120, Second 32 beats at 60
    // Live's current tempo no longer changes the set length.
    fake.set.beats = 20;
    fake.set.tempo = 200;
    fake.pushPosition();
    await until(() => controller.position.tempo === 200);
    assert.equal(controller.snapshot().totalSeconds, total);
  } finally {
    done();
  }
});

test('a song tempo only lasts while that song plays; other songs get the automation back', async () => {
  const { fake, controller, client, done } = await setup();
  try {
    fake.tempoMap = [[0, 120], [40, 60]]; // Song Tempo automation: First at 120, Second at 60
    await client.start();
    await until(() => controller.songs.length === 2);
    await controller.setTempo('second', 90);
    await controller.cue('second');
    assert.equal(fake.set.tempo, 90);
    assert.equal(fake.overridden, true, 'Live overrides the automation, as it does');
    await controller.cue('first');
    assert.equal(fake.overridden, false, 'automation re-enabled');
    assert.equal(fake.set.tempo, 120, "First is back at its automated tempo");
    assert.ok(fake.methods().includes('restore_tempo'));
  } finally {
    done();
  }
});

test('moving into a song in Live itself also hands tempo back to the automation', async () => {
  const { fake, controller, client, done } = await setup();
  try {
    fake.tempoMap = [[0, 120], [40, 60]];
    await client.start();
    await until(() => controller.songs.length === 2);
    await controller.setTempo('first', 100);
    await controller.start('first');
    assert.equal(fake.set.tempo, 100);
    // The user drags the playhead into Second in Live while playing.
    fake.set.beats = 44;
    fake.pushPosition();
    await until(() => fake.overridden === false);
    assert.equal(fake.set.tempo, 60);
  } finally {
    done();
  }
});

test('a tempo override from before Ablecon started is cleaned up on the next song', async () => {
  const { fake, controller, client, done } = await setup();
  try {
    fake.tempoMap = [[0, 120], [40, 60]];
    fake.overridden = true; // left over from an earlier session
    fake.set.tempo = 77;
    await client.start();
    await until(() => controller.songs.length === 2);
    await controller.cue('second');
    assert.equal(fake.overridden, false);
    assert.equal(fake.set.tempo, 60);
  } finally {
    done();
  }
});

test('with an old Remote Script, restoring the tempo asks for an update once', async () => {
  const { fake, controller, client, done } = await setup();
  try {
    fake.oldScript = true;
    fake.tempoMap = [[0, 120], [40, 60]];
    await client.start();
    await until(() => controller.songs.length === 2);
    const notices: string[] = [];
    controller.on('notice', (n) => notices.push(n.text));
    await controller.setTempo('second', 90);
    await controller.cue('second');
    await controller.cue('first');
    await controller.cue('second');
    await controller.cue('first');
    assert.equal(notices.filter((n) => /spreading to other songs/.test(n)).length, 1);
  } finally {
    done();
  }
});

test('Next section while playing waits for the second bar line, then jumps', async () => {
  const { fake, controller, client, done } = await setup();
  try {
    await client.start();
    await until(() => controller.songs.length === 2);
    // First: Verse 0-16, Chorus 16-32 (4/4, so a bar is 4 beats).
    await controller.start('first');
    fake.set.beats = 5; // in bar 2
    fake.pushPosition();
    await until(() => controller.position.beats === 5);
    await controller.nextSection();
    assert.deepEqual(fake.scheduled, { at: 12, to: 16 }, 'jump at the start of bar 4 (two bar lines on)');
    assert.equal(controller.pendingJump?.name, 'Chorus');
    assert.equal(controller.snapshot().pendingJump?.at, 12);
    fake.set.beats = 11.9;
    fake.pushPosition(); // the fake, like the script, jumps on its last tick before beat 12
    await until(() => controller.pendingJump === null);
    assert.ok(Math.abs(fake.set.beats - 15.9) < 1e-9, 'landed so the Chorus downbeat is on time');
  } finally {
    done();
  }
});

test('Next section: nothing to jump when the section starts within the wait anyway', async () => {
  const { fake, controller, client, done } = await setup();
  try {
    await client.start();
    await until(() => controller.songs.length === 2);
    await controller.start('first');
    fake.set.beats = 13; // bar 4: two bar lines on is beat 20, after the Chorus starts at 16
    fake.pushPosition();
    await until(() => controller.position.beats === 13);
    const notices: string[] = [];
    controller.on('notice', (n) => notices.push(n.text));
    await controller.nextSection();
    assert.equal(fake.scheduled, null);
    assert.match(notices.join(), /Chorus starts within 2 bars anyway/);
  } finally {
    done();
  }
});

test('Next section when stopped moves straight there; cancel and stop drop a waiting jump', async () => {
  const { fake, controller, client, done } = await setup();
  try {
    await client.start();
    await until(() => controller.songs.length === 2);
    await controller.cue('first');
    await controller.nextSection();
    assert.equal(fake.set.beats, 16);
    assert.equal(fake.set.playing, false);
    await controller.updateSettings({ jumpBars: 1 });
    await controller.start('second');
    await controller.nextSection(); // at beat 40: one bar line on is 44; Chorus at 56
    assert.deepEqual(fake.scheduled, { at: 44, to: 56 });
    await controller.cancelJump();
    assert.equal(fake.scheduled, null);
    assert.equal(controller.pendingJump, null);
    await controller.nextSection();
    await controller.stop();
    assert.equal(fake.scheduled, null, 'stopping cancels it');
    await controller.cue('second');
    await controller.nextSection(); // stopped at Verse: goes to Chorus...
    await assert.rejects(controller.nextSection(), /no section after/); // ...the last one
  } finally {
    done();
  }
});

test('Next section with an old Remote Script says to update it', async () => {
  const { fake, controller, client, done } = await setup();
  try {
    fake.oldScript = true;
    await client.start();
    await until(() => controller.songs.length === 2);
    await controller.start('first');
    await assert.rejects(controller.nextSection(), /newer Remote Script/);
  } finally {
    done();
  }
});

test('section loop toggles on and off', async () => {
  const { fake, controller, client, done } = await setup();
  try {
    await client.start();
    await until(() => controller.songs.length === 2);
    await controller.toggleLoop('first', 1);
    assert.deepEqual(fake.set.loop, { enabled: true, start: 16, length: 16 });
    assert.equal(fake.set.beats, 16, 'stopped outside the section: playhead moves to it');
    fake.pushPosition();
    await until(() => controller.position.loop.enabled);
    await controller.toggleLoop('first', 1);
    assert.equal(fake.set.loop.enabled, false);
  } finally {
    done();
  }
});

test('controller lists tracks and mutes and unmutes them', async () => {
  const { fake, controller, client, done } = await setup();
  try {
    await client.start();
    await until(() => controller.tracks.length === 3);
    assert.deepEqual(controller.snapshot().tracks.map((t) => [t.name, t.muted]), [['Click [nokey]', false], ['Keys', false], ['Synth', false]]);
    await controller.setMute(1, 'Keys', true);
    assert.ok(fake.muted.has(1));
    assert.equal(controller.tracks[1].muted, true);
    await controller.setMute(1, 'Keys', false);
    assert.ok(!fake.muted.has(1));
    await assert.rejects(controller.setMute(1, 'Pad', true), /moved or been renamed/);
    assert.ok(!fake.muted.has(1), 'nothing muted when the name does not match');
  } finally {
    done();
  }
});

test('solo and clear solos; other tracks show as silenced', async () => {
  const { fake, controller, client, done } = await setup();
  try {
    await client.start();
    await until(() => controller.tracks.length === 3);
    await controller.setSolo(1, 'Keys', true);
    assert.ok(fake.soloed.has(1));
    assert.deepEqual(controller.tracks.map((t) => [t.name, t.soloed, t.mutedViaSolo]), [
      ['Click [nokey]', false, true], ['Keys', true, false], ['Synth', false, true],
    ]);
    await controller.setSolo(2, 'Synth', true);
    await controller.clearSolos();
    assert.equal(fake.soloed.size, 0);
    assert.ok(controller.tracks.every((t) => !t.soloed && !t.mutedViaSolo));
    await assert.rejects(controller.setSolo(1, 'Pad', true), /moved or been renamed/);
  } finally {
    done();
  }
});

test('solo with an old Remote Script says to update it', async () => {
  const { fake, controller, client, done } = await setup();
  try {
    fake.oldScript = true;
    await client.start();
    await until(() => controller.tracks.length === 3);
    await assert.rejects(controller.setSolo(1, 'Keys', true), /newer Remote Script/);
    await assert.rejects(controller.clearSolos(), /newer Remote Script/);
  } finally {
    done();
  }
});

test('mutes made in Live show up after a change notice', async () => {
  const { fake, controller, client, done } = await setup();
  try {
    await client.start();
    await until(() => controller.tracks.length === 3);
    fake.muted.add(2); // the user mutes Synth in Live
    fake.pushChanged('tracks');
    await until(() => controller.tracks[2].muted);
  } finally {
    done();
  }
});

test('a mute is not held up by a slow command in the queue', async () => {
  const { fake, controller, client, done } = await setup();
  try {
    await client.start();
    await until(() => controller.tracks.length === 3);
    fake.ignore.add('play_from'); // the queued command hangs until it times out (500 ms)
    let slowDone = false;
    const slow = controller.play().catch(() => {}).finally(() => (slowDone = true));
    await sleep(20);
    const t0 = Date.now();
    await controller.setMute(0, 'Click [nokey]', true);
    assert.ok(Date.now() - t0 < 300, 'mute answered before the stuck command timed out');
    assert.ok(fake.muted.has(0));
    assert.equal(slowDone, false, 'the slow command was still waiting');
    await slow;
  } finally {
    done();
  }
});

// ---- the real Remote Script code, through the Python fake Live -----------------

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function freeUdpPort(): Promise<number> {
  const s = dgram.createSocket('udp4');
  await new Promise<void>((r) => s.bind(0, '127.0.0.1', r));
  const { port } = s.address();
  s.close();
  return port;
}

test('end to end with the Python Remote Script handlers', async (t) => {
  const port = await freeUdpPort();
  const py = spawn('python3', [path.join(root, 'remote_script/fake_live/fake_live_server.py'), '--port', String(port), '--set', 'marked'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const started = await Promise.race([
    once(py.stdout, 'data').then(() => true),
    once(py, 'error').then(() => false),
    sleep(5000).then(() => false),
  ]);
  if (!started) {
    py.kill();
    t.skip('python3 not available');
    return;
  }
  const client = new LiveClient({ port, heartbeatMs: 60_000 });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ablecon-'));
  const controller = new Controller(client, path.join(dir, 's.json'));
  try {
    await controller.init();
    await client.start();
    await until(() => controller.songs.length === 3, 4000);
    assert.deepEqual(controller.songs.map((s) => s.name), ['Morning Light', 'River Wide', 'Still Waters']);
    await controller.setKey('river wide', 2);
    await controller.setTempo('river wide', 72);
    await controller.cue('river wide');
    const status = controller.keyStatus.get('river wide');
    assert.equal(status?.semitones, 2);
    assert.match(status!.warnings.join(), /Pad RW/);
    const state = await client.call<{ beats: number; tempo: number }>('state');
    assert.equal(state.beats, 200);
    assert.equal(state.tempo, 72);
    const { tracks } = await client.call<{ tracks: Array<{ name: string; clips: Array<{ pitch: number }> }> }>('tracks', { start: 200, end: 312 });
    assert.equal(tracks.find((tr) => tr.name === 'Keys')!.clips[0].pitch, 2);
    assert.equal(tracks.find((tr) => tr.name === 'Click [nokey]')!.clips[0].pitch, 0);
    await until(() => controller.tracks.length === 6);
    await controller.setMute(3, 'Keys', true);
    const mixer = await client.call<{ tracks: Array<{ name: string; muted: boolean }> }>('mixer');
    assert.equal(mixer.tracks[3].muted, true);
  } finally {
    client.stop();
    py.kill();
  }
});

test('the tempo of the song under the playhead is learned when the set is read', async () => {
  const { fake, controller, client, done } = await setup();
  try {
    fake.set.beats = 41; // parked at the start of Second, never moves
    fake.set.tempo = 64;
    await client.start();
    await until(() => controller.file.entries.find((e) => e.songId === 'second')?.seenTempo === 64);
    const row = controller.snapshot().rows.find((r) => r.songId === 'second');
    assert.equal(row?.seenTempo, 64);
  } finally {
    done();
  }
});

test("a song's tempo override is not mistaken for another song's automated tempo", async () => {
  const { fake, controller, client, done } = await setup();
  try {
    fake.tempoMap = [[0, 120], [40, 60]];
    await client.start();
    await until(() => controller.songs.length === 2);
    await controller.setTempo('first', 128);
    await controller.cue('first'); // override: Live is at 128 everywhere
    const seen = () => controller.file.entries.find((e) => e.songId === 'second')?.seenTempo;
    // The playhead reaches Second while the override is still active: 128 must not be learned.
    fake.overridden = true;
    fake.set.beats = 41;
    fake.set.tempo = 128;
    fake.pushPosition();
    await until(() => controller.position.beats === 41);
    await until(() => fake.overridden === false); // Ablecon hands tempo back for Second...
    fake.pushPosition(); // ...and the next report shows the automated 60
    await until(() => seen() === 60);
  } finally {
    done();
  }
});

test("each song's tempo is read at its marker, without playing, and the playhead goes back", async () => {
  const { fake, controller, client, done } = await setup();
  try {
    fake.tempoMap = [[0, 120], [40, 60]]; // automation: First 120, Second 60
    fake.set.beats = 20;
    await client.start();
    await until(() => controller.snapshot().rows.length === 2 && controller.snapshot().rows.every((r) => r.seenTempo != null));
    assert.deepEqual(controller.snapshot().rows.map((r) => [r.name, r.seenTempo]), [['First', 120], ['Second', 60]]);
    assert.equal(fake.set.beats, 20, 'playhead put back');
    assert.equal(fake.startMarker, 20, "Live's start marker put back too");
    assert.equal(fake.set.playing, false, 'nothing played');
    assert.equal(controller.position.tempo, 120, "Ablecon shows Live's tempo where the playhead is, not the last song read");
    assert.equal(controller.snapshot().totalSeconds, 32 * 0.5 + 32 * 1);
  } finally {
    done();
  }
});

test('tempos are read once Live stops if it was playing', async () => {
  const { fake, controller, client, done } = await setup();
  try {
    fake.tempoMap = [[0, 120], [40, 60]];
    fake.set.playing = true;
    fake.set.beats = 4;
    await client.start();
    await until(() => controller.songs.length === 2);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fake.methods().filter((m) => m === 'jump').length, 0, 'no playhead moves while playing');
    fake.set.playing = false;
    fake.pushPosition();
    await until(() => controller.snapshot().rows.length === 2 && controller.snapshot().rows.every((r) => r.seenTempo != null));
    assert.equal(controller.snapshot().rows[1].seenTempo, 60);
  } finally {
    done();
  }
});

test("a song's own tempo is put back after reading the automation", async () => {
  const { fake, controller, client, done } = await setup();
  try {
    fake.tempoMap = [[0, 120], [40, 60]];
    await client.start();
    await until(() => controller.songs.length === 2);
    await controller.setTempo('first', 100);
    await controller.cue('first');
    assert.equal(fake.set.tempo, 100);
    await controller.refresh(); // e.g. a locator was edited: tempos are read again
    assert.equal(controller.snapshot().rows[0].seenTempo, 120, 'the automated tempo, not the override');
    assert.equal(fake.set.tempo, 100, "First's own tempo is back");
    assert.equal(fake.set.beats, 0);
  } finally {
    done();
  }
});
