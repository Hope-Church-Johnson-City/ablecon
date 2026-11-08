"""A stand-in for Live's Song object with just the API Ablecon uses.

Used by the Python unit tests and by fake_live_server.py, which lets you run
the Ablecon server and web UI without Ableton Live.
"""

import os


class CuePoint(object):
    def __init__(self, name, time):
        self.name = name
        self.time = float(time)


class Param(object):
    def __init__(self, name, value=0.0, min=0.0, max=1.0):
        self.name = name
        self.value = float(value)
        self.min = float(min)
        self.max = float(max)


class Device(object):
    def __init__(self, name, class_name, parameters):
        self.name = name
        self.class_name = class_name
        self.parameters = parameters


def pitch_device(name="Pitch"):
    return Device(name, "MidiPitcher", [
        Param("Device On", 1, 0, 1),
        Param("Pitch", 0, -48, 48),
        Param("Range", 127, 0, 127),
        Param("Lowest", 0, 0, 127),
    ])


class WarpMarker(object):
    def __init__(self, beat_time, sample_time):
        self.beat_time = float(beat_time)
        self.sample_time = float(sample_time)  # seconds into the audio file, as in Live


class Clip(object):
    def __init__(self, name, start, end, audio=True, warping=True, pitch=0, file_path=None,
                 start_marker=0.0, warp_markers=None):
        self.name = name
        self.start_time = float(start)
        self.end_time = float(end)
        self.is_audio_clip = audio
        self.warping = warping
        self._pitch = pitch
        self.muted = False
        self.looping = False
        self.loop_start = float(start_marker)
        self.loop_end = float(start_marker) + (self.end_time - self.start_time)
        self.start_marker = float(start_marker)
        self.end_marker = self.loop_end
        self.gain = 0.4
        if audio:
            # Live gives every audio clip its file and (for warped audio) warp
            # markers; here the audio was recorded at 120 BPM by default.
            self._file = file_path or "/Audio/%s.wav" % name
            self._warp = warp_markers if warp_markers is not None else [
                WarpMarker(0, 0), WarpMarker(self.loop_end, self.loop_end * 0.5)]
        else:
            self._file = None
            self._warp = []

    @property
    def file_path(self):
        if not self.is_audio_clip:
            raise AttributeError("MIDI clips have no file_path")
        return self._file

    @property
    def warp_markers(self):
        if not self.is_audio_clip:
            raise AttributeError("MIDI clips have no warp_markers")
        return self._warp

    @property
    def pitch_coarse(self):
        if not self.is_audio_clip:
            raise AttributeError("MIDI clips have no pitch_coarse")
        return self._pitch

    @pitch_coarse.setter
    def pitch_coarse(self, value):
        if not self.is_audio_clip:
            raise AttributeError("MIDI clips have no pitch_coarse")
        self._pitch = int(value)


class Track(object):
    def __init__(self, name, midi=False, clips=None, devices=None, group=None, foldable=False):
        self.name = name
        self.has_midi_input = midi
        self.has_audio_input = not midi
        self.is_foldable = foldable
        self.group_track = group
        self.mute = False
        self.solo = False
        self.song = None  # set by Song, so muted_via_solo can look at the other tracks
        self._clips = clips or []
        self.devices = devices or []

    def _ancestors(self):
        group = self.group_track
        while group is not None:
            yield group
            group = group.group_track

    @property
    def muted_via_solo(self):
        """Silent because some other track is soloed (as Live works it out)."""
        if self.song is None or self.solo or any(g.solo for g in self._ancestors()):
            return False
        soloed = [t for t in self.song.tracks if t.solo]
        if not soloed:
            return False
        # A group stays audible when something inside it is soloed.
        return not any(self in t._ancestors() for t in soloed)

    @property
    def arrangement_clips(self):
        if self.is_foldable:
            raise RuntimeError("group tracks have no arrangement clips")
        return self._clips


class Song(object):
    def __init__(self, cue_points=None, tracks=None, tempo=120.0, song_length=0.0, tempo_map=None):
        self.cue_points = cue_points or []
        self.tracks = tracks or []
        for track in self.tracks:
            track.song = self
        # tempo_map: [(beat, bpm), ...] imitates a Song Tempo automation lane.
        self.tempo_map = sorted(tempo_map or [])
        self.re_enable_automation_enabled = False
        self._tempo = float(tempo)
        self.is_playing = False
        self.current_song_time = 0.0
        self.loop = False
        self.loop_start = 0.0
        self.loop_length = 16.0
        self.signature_numerator = 4
        self.signature_denominator = 4
        self.song_length = float(song_length)
        # Like Live: start_playing() begins at the start marker, and
        # continue_playing() where playback last stopped. Moving
        # current_song_time while stopped changes neither.
        self._start_time = 0.0
        self.stop_position = 0.0
        self.has_start_time = True  # False imitates a Live without Song.start_time
        self.calls = []

    @property
    def start_time(self):
        if not self.has_start_time:
            raise AttributeError("start_time")
        return self._start_time

    @start_time.setter
    def start_time(self, value):
        if not self.has_start_time:
            raise AttributeError("start_time")
        self._start_time = float(value)

    def _automated_tempo(self):
        bpm = None
        for beat, value in self.tempo_map:
            if beat <= self.current_song_time:
                bpm = value
        return bpm

    @property
    def tempo(self):
        if self.tempo_map and not self.re_enable_automation_enabled:
            return self._automated_tempo() or self._tempo
        return self._tempo

    @tempo.setter
    def tempo(self, value):
        self._tempo = float(value)
        if self.tempo_map:
            self.re_enable_automation_enabled = True  # like Live: overrides the lane everywhere

    def re_enable_automation(self):
        self.calls.append("re_enable_automation")
        self.re_enable_automation_enabled = False

    def start_playing(self):
        self.calls.append("start_playing")
        self.current_song_time = self._start_time
        self.is_playing = True

    def continue_playing(self):
        self.calls.append("continue_playing")
        self.current_song_time = self.stop_position
        self.is_playing = True

    def stop_playing(self):
        self.calls.append("stop_playing")
        if self.is_playing:
            self.stop_position = self.current_song_time
        self.is_playing = False

    def advance(self, seconds):
        """Move the playhead as if Live had been playing for `seconds`."""
        if not self.is_playing:
            return
        self.current_song_time += seconds * self.tempo / 60.0
        if self.loop:
            end = self.loop_start + self.loop_length
            while self.current_song_time >= end:
                self.current_song_time -= self.loop_length


def demo_song():
    """Three songs with sections, a click/guide pair, stems and a synth."""
    cues = [
        CuePoint("// Pre-service loop", 0),
        CuePoint("*Morning Light", 8),
        CuePoint("Intro", 8),
        CuePoint("Verse 1", 16),
        CuePoint("Chorus", 48),
        CuePoint("Verse 2", 80),
        CuePoint("Chorus", 112),
        CuePoint("Bridge", 144),
        CuePoint("Outro", 176),
        CuePoint("--", 192),
        CuePoint("*River Wide", 200),
        CuePoint("Intro", 200),
        CuePoint("Verse", 216),
        CuePoint("Chorus", 248),
        CuePoint("Tag", 280),
        CuePoint("*Still Waters", 312),
        CuePoint("Verse", 312),
        CuePoint("Chorus", 344),
        CuePoint("End", 392),
        CuePoint("--", 408),
    ]
    stems = Track("Stems", foldable=True)
    tracks = [
        Track("Click [nokey]", clips=[Clip("click", 8, 192), Clip("click", 200, 312),
                                      Clip("click", 312, 408)]),
        Track("Guide [nokey]", clips=[Clip("guide", 8, 192), Clip("guide", 200, 312),
                                      Clip("guide", 312, 408)]),
        stems,
        Track("Keys", group=stems, clips=[Clip("Keys ML", 8, 192), Clip("Keys RW", 200, 312),
                                          Clip("Keys SW", 312, 408)]),
        Track("Pad", group=stems, clips=[Clip("Pad ML", 8, 192),
                                         Clip("Pad RW", 200, 312, warping=False),
                                         Clip("Pad SW", 312, 408)]),
        Track("Synth", midi=True, clips=[Clip("Synth ML", 8, 192, audio=False)],
              devices=[pitch_device()]),
    ]
    return Song(cues, tracks, tempo=120.0, song_length=408.0)


def plain_song(audio_dir=None):
    """Laid out like a typical worship multitrack set: plain song locators with
    the key in brackets, STOP markers, a MIDI "Sections" track whose clips name
    the parts, click and guide tracks, and one group of stems per song.
    With `audio_dir`, every stem of a song plays the file <audio_dir>/<song>.wav."""
    cues = [
        CuePoint("Morning Light (G)", 0),
        CuePoint("STOP", 135),
        CuePoint("River Wide (Bb)", 140),
        CuePoint("Still Waters (Em)", 263),  # no STOP before it: River Wide runs straight on
        CuePoint("STOP", 395),
    ]
    parts = [
        ("Count Off", 0, 8), ("Intro", 8, 24), ("Verse 1", 24, 56), ("Chorus", 56, 88),
        ("Bridge", 88, 120), ("Outro", 120, 135),
        ("Count Off", 140, 148), ("Intro", 148, 164), ("Verse", 164, 196), ("Chorus", 196, 228),
        ("Tag", 228, 263),
        ("Verse", 263, 308), ("Chorus", 308, 340), ("Ending", 340, 395),
    ]
    tracks = [
        Track("Sections", midi=True, clips=[Clip(n, s, e, audio=False) for n, s, e in parts]),
        Track("Click Foundations", clips=[Clip("click", 0, 395)]),
        Track("Guide", clips=[Clip("guide", 0, 395)]),
    ]
    # Group names don't always match the song exactly ("Rivr Wide"), as in real sets.
    for title, group_name, start, end in (("Morning Light", "Morning Light", 0, 135),
                                          ("River Wide", "Rivr Wide", 140, 263),
                                          ("Still Waters", "Still Waters", 263, 395)):
        group = Track(group_name, foldable=True)
        tracks.append(group)
        for stem in ("Drums", "Perc", "Loop", "Bass", "Synth Bass", "AG", "EG 1", "EG 2", "EG 3",
                     "Piano", "Keys 1", "Keys 2", "Synth Pad", "Organ", "Strings", "BGVS", "Choir"):
            audio = os.path.join(audio_dir, title + ".wav") if audio_dir else None
            tracks.append(Track(stem, group=group, clips=[Clip("%s %s" % (title, stem), start, end,
                                                               file_path=audio)]))
    return Song(cues, tracks, tempo=72.0, song_length=395.0,
                tempo_map=[(0, 72.0), (140, 128.0), (263, 68.0)])
