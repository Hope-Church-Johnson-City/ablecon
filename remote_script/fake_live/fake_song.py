"""A stand-in for Live's Song object with just the API Ablcon uses.

Used by the Python unit tests and by fake_live_server.py, which lets you run
the Ablcon server and web UI without Ableton Live.
"""


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


class Clip(object):
    def __init__(self, name, start, end, audio=True, warping=True, pitch=0):
        self.name = name
        self.start_time = float(start)
        self.end_time = float(end)
        self.is_audio_clip = audio
        self.warping = warping
        self._pitch = pitch

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
        self._clips = clips or []
        self.devices = devices or []

    @property
    def arrangement_clips(self):
        if self.is_foldable:
            raise RuntimeError("group tracks have no arrangement clips")
        return self._clips


class Song(object):
    def __init__(self, cue_points=None, tracks=None, tempo=120.0, song_length=0.0):
        self.cue_points = cue_points or []
        self.tracks = tracks or []
        self.tempo = float(tempo)
        self.is_playing = False
        self.current_song_time = 0.0
        self.loop = False
        self.loop_start = 0.0
        self.loop_length = 16.0
        self.signature_numerator = 4
        self.signature_denominator = 4
        self.song_length = float(song_length)
        self.calls = []

    def start_playing(self):
        self.calls.append("start_playing")
        self.is_playing = True

    def continue_playing(self):
        self.calls.append("continue_playing")
        self.is_playing = True

    def stop_playing(self):
        self.calls.append("stop_playing")
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
