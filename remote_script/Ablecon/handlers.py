"""Request handlers for the Ablecon Remote Script.

Every handler takes the Live Song object and a dict of arguments and returns
something JSON-serialisable. Nothing here imports Live modules, so the same
code runs under the unit tests with a fake Song.
"""

SCRIPT_VERSION = "1.4.1"

# Class name Live reports for its built-in "Pitch" MIDI effect.
PITCH_DEVICE_CLASS = "MidiPitcher"


class RequestError(Exception):
    pass


def _num(args, key):
    if key not in args:
        raise RequestError("missing argument '%s'" % key)
    try:
        return float(args[key])
    except (TypeError, ValueError):
        raise RequestError("argument '%s' must be a number" % key)


def _safe(fn, default=None):
    try:
        return fn()
    except Exception:
        return default


def ping(song, args, app_version=None):
    return {"script": "ablecon", "version": SCRIPT_VERSION, "live": app_version}


def state(song, args):
    return {
        "beats": song.current_song_time,
        "playing": bool(song.is_playing),
        "tempo": song.tempo,
        "loop": {
            "enabled": bool(song.loop),
            "start": song.loop_start,
            "length": song.loop_length,
        },
        "signature": [song.signature_numerator, song.signature_denominator],
        # True when some automation (e.g. the tempo lane) is overridden.
        "automationOverridden": bool(_safe(lambda: song.re_enable_automation_enabled, False)),
    }


def cues(song, args):
    return {
        "cues": [{"name": cp.name, "time": cp.time} for cp in song.cue_points],
        "songLength": _safe(lambda: song.song_length, 0.0),
        "tempo": song.tempo,
        "signature": [song.signature_numerator, song.signature_denominator],
    }


SECTIONS_TRACK = "sections"


def cue_signature(song):
    """Cheap fingerprint of the locators and of the clips on a track named
    "Sections", used to notice edits in Live."""
    cues = tuple((cp.name, round(cp.time, 4)) for cp in song.cue_points)
    clips = ()
    for track in song.tracks:
        if track.name.strip().lower() == SECTIONS_TRACK:
            clips = tuple((c.name, round(c.start_time, 4))
                          for c in _safe(lambda: list(track.arrangement_clips), []))
            break
    return cues, clips


def play(song, args):
    song.start_playing()
    return True


def resume(song, args):
    song.continue_playing()
    return True


def stop(song, args):
    song.stop_playing()
    return True


# Live has two start points besides the visible playhead: start_playing()
# begins at the start marker (Song.start_time) and continue_playing() at the
# position where playback last stopped. Moving current_song_time while stopped
# changes neither, so a later Play would start somewhere else. Ablecon moves the
# start marker too, and falls back to "start, then jump" if this Live has no
# start_time.
_pending_jump = {"beats": None}


def _set_start_marker(song, beats):
    """Move Live's start marker. Returns False if this Live version can't."""
    try:
        song.start_time = beats
        return True
    except Exception:
        return False


def jump(song, args):
    beats = _num(args, "beats")
    if beats < 0:
        raise RequestError("beats must be >= 0")
    marker = False
    if not song.is_playing:
        marker = _set_start_marker(song, beats)
    song.current_song_time = beats
    return {"startMarker": marker}


def play_from(song, args):
    """Start playback exactly at `beats`."""
    beats = _num(args, "beats")
    if beats < 0:
        raise RequestError("beats must be >= 0")
    if song.is_playing:
        song.current_song_time = beats
        return {"method": "jump"}
    if _set_start_marker(song, beats):
        song.current_song_time = beats
        song.start_playing()
        return {"method": "start_marker"}
    # Older Live: start, then jump on the next tick once playback is running.
    _pending_jump["beats"] = beats
    song.continue_playing()
    return {"method": "jump_after_start"}


# A jump scheduled for a later beat (e.g. "next section in two bars").
# Ablecon's server only sees the playhead ~10 times a second, so the timing
# lives here, on Live's own tick.
_scheduled = {"at": None, "to": None, "seen": None}


def _clear_scheduled():
    _scheduled.update(at=None, to=None, seen=None)


def jump_at(song, args):
    """Jump to beat `to` when playback reaches beat `at`."""
    at = _num(args, "at")
    to = _num(args, "to")
    if to < 0:
        raise RequestError("'to' must be >= 0")
    if not song.is_playing:
        _clear_scheduled()
        jump(song, {"beats": to})
        return {"method": "now"}
    now = song.current_song_time
    if at <= now:
        raise RequestError("that point has already been played")
    _scheduled.update(at=at, to=to, seen=now)
    return {"method": "scheduled"}


def cancel_jump(song, args):
    was = _scheduled["at"] is not None
    _clear_scheduled()
    return {"cancelled": was}


def run_scheduled_jump(song, tick_seconds):
    """Called every tick. Performs a scheduled jump so the target lands on time.

    Ticks come roughly every 100 ms, so the jump can't happen exactly at
    `at`. It happens on the last tick before `at` (when the next tick would
    already be past it), into the matching point just before `to`: the
    target's downbeat then plays exactly when `at` would have, and only the
    last tick's worth of the old bar is replaced by the end of the bar before
    the target, which is usually its natural lead-in. Waiting for a tick
    after `at` instead would clip the target's downbeat (seen in Live: about
    20 ms late with a smaller margin). Returns True when it jumped.
    """
    at = _scheduled["at"]
    if at is None:
        return False
    now = song.current_song_time
    # Stopped, or the playhead was moved (backwards, or far past the point): give up.
    if not song.is_playing or now < _scheduled["seen"] - 0.01 or now > at + 4:
        _clear_scheduled()
        return False
    beats_per_second = song.tempo / 60.0
    # One tick's worth of beats, plus a little for jitter: if the next tick
    # would land after `at`, this tick is the last one before it.
    lead = min(0.5, max(0.02, min(tick_seconds, 0.25)) * beats_per_second * 1.2)
    if now >= at - lead:
        song.current_song_time = max(0.0, _scheduled["to"] - (at - now))
        _clear_scheduled()
        return True
    _scheduled["seen"] = now
    return False


def apply_pending_jump(song):
    """Called every tick by the surface; finishes a play_from fallback."""
    beats = _pending_jump["beats"]
    if beats is None:
        return
    if song.is_playing:
        _pending_jump["beats"] = None
        song.current_song_time = beats


def tempo(song, args):
    bpm = _num(args, "bpm")
    if not 20.0 <= bpm <= 999.0:
        raise RequestError("tempo must be between 20 and 999 BPM")
    song.tempo = bpm
    return True


def restore_tempo(song, args):
    """Hand tempo back to the set's tempo automation after Ablecon overrode it.

    Setting Song.tempo in a set with tempo automation overrides that
    automation everywhere (Live lights its "Re-enable Automation" button).
    Live can't re-enable a single lane from a script, so this re-enables
    overridden automation, which brings the tempo lane back.
    """
    if not _safe(lambda: song.re_enable_automation_enabled, False):
        return {"reenabled": False}
    song.re_enable_automation()
    return {"reenabled": True}


def loop(song, args):
    enabled = bool(args.get("enabled", True))
    if "start" in args and "length" in args:
        start = _num(args, "start")
        length = _num(args, "length")
        if start < 0 or length <= 0:
            raise RequestError("loop start must be >= 0 and length > 0")
        # Setting start first can fail if start + old length passes the set
        # end, so shrink the length first.
        song.loop_length = min(song.loop_length, length)
        song.loop_start = start
        song.loop_length = length
    song.loop = enabled
    return True


def _parent_names(track):
    names = []
    parent = _safe(lambda: track.group_track)
    while parent is not None:
        names.append(parent.name)
        parent = _safe(lambda: parent.group_track)
    return names


def tracks(song, args):
    """Describe tracks, clips and Pitch devices relevant to a beat range."""
    start = _num(args, "start")
    end = _num(args, "end")
    result = []
    for t_index, track in enumerate(song.tracks):
        is_group = bool(_safe(lambda: track.is_foldable, False))
        info = {
            "index": t_index,
            "name": track.name,
            "parents": _parent_names(track),
            "isMidi": bool(_safe(lambda: track.has_midi_input, False)),
            "isAudio": bool(_safe(lambda: track.has_audio_input, False)),
            "isGroup": is_group,
            "clips": [],
            "pitchDevices": [],
        }
        if not is_group:
            clips = _safe(lambda: list(track.arrangement_clips), [])
            for c_index, clip in enumerate(clips):
                if clip.end_time <= start or clip.start_time >= end:
                    continue
                is_audio = bool(clip.is_audio_clip)
                info["clips"].append({
                    "index": c_index,
                    "name": clip.name,
                    "start": clip.start_time,
                    "end": clip.end_time,
                    "isAudio": is_audio,
                    "warping": bool(clip.warping) if is_audio else None,
                    "pitch": clip.pitch_coarse if is_audio else None,
                })
        for d_index, device in enumerate(_safe(lambda: list(track.devices), [])):
            if _safe(lambda: device.class_name) != PITCH_DEVICE_CLASS:
                continue
            info["pitchDevices"].append({
                "index": d_index,
                "name": device.name,
                "params": [
                    {"index": p_index, "name": p.name, "value": p.value,
                     "min": p.min, "max": p.max}
                    for p_index, p in enumerate(device.parameters)
                ],
            })
        result.append(info)
    return {"tracks": result}


def mixer(song, args):
    """Every track with its mute state, in Live's order (grouped tracks included)."""
    result = []
    for index, track in enumerate(song.tracks):
        result.append({
            "index": index,
            "name": track.name,
            "parents": _parent_names(track),
            "isGroup": bool(_safe(lambda: track.is_foldable, False)),
            "muted": bool(track.mute),
            "soloed": bool(_safe(lambda: track.solo, False)),
            "mutedViaSolo": bool(_safe(lambda: track.muted_via_solo, False)),
        })
    return {"tracks": result}


def mixer_signature(song):
    """Cheap fingerprint of track names and mute states, to notice changes in Live."""
    return tuple((t.name, bool(t.mute), bool(_safe(lambda: t.solo, False)),
                  bool(_safe(lambda: t.muted_via_solo, False)))
                 for t in song.tracks)


def mute(song, args):
    track = _track_checked(song, args)
    if "muted" not in args:
        raise RequestError("missing argument 'muted'")
    track.mute = bool(args["muted"])
    return {"muted": bool(track.mute)}


def solo(song, args):
    """Solo or unsolo one track. Other solos are left as they are."""
    track = _track_checked(song, args)
    if "soloed" not in args:
        raise RequestError("missing argument 'soloed'")
    track.solo = bool(args["soloed"])
    return {"soloed": bool(track.solo)}


def clear_solos(song, args):
    cleared = 0
    for track in song.tracks:
        if _safe(lambda: track.solo, False):
            track.solo = False
            cleared += 1
    return {"cleared": cleared}


def _track_checked(song, op):
    all_tracks = list(song.tracks)
    index = int(op.get("track", -1))
    if not 0 <= index < len(all_tracks):
        raise RequestError("track %s no longer exists" % index)
    track = all_tracks[index]
    if "trackName" in op and track.name != op["trackName"]:
        raise RequestError("track %d was renamed or moved (expected '%s', found '%s')"
                           % (index, op["trackName"], track.name))
    return track


def _apply_op(song, op):
    kind = op.get("kind")
    track = _track_checked(song, op)
    if kind == "clip":
        clips = list(track.arrangement_clips)
        index = int(op.get("clip", -1))
        if not 0 <= index < len(clips):
            raise RequestError("clip %s on '%s' no longer exists" % (index, track.name))
        clip = clips[index]
        if "start" in op and abs(clip.start_time - float(op["start"])) > 1e-6:
            raise RequestError("clip on '%s' moved since it was read" % track.name)
        if not clip.is_audio_clip:
            raise RequestError("clip on '%s' is not an audio clip" % track.name)
        pitch = int(op["pitch"])
        if not -48 <= pitch <= 48:
            raise RequestError("pitch out of range")
        clip.pitch_coarse = pitch
    elif kind == "param":
        devices = list(track.devices)
        d_index = int(op.get("device", -1))
        if not 0 <= d_index < len(devices):
            raise RequestError("device %s on '%s' no longer exists" % (d_index, track.name))
        params = list(devices[d_index].parameters)
        p_index = int(op.get("param", -1))
        if not 0 <= p_index < len(params):
            raise RequestError("parameter %s no longer exists" % p_index)
        param = params[p_index]
        value = max(param.min, min(param.max, float(op["value"])))
        param.value = value
    else:
        raise RequestError("unknown op kind %r" % (kind,))


def apply(song, args):
    """Apply a list of key-change operations. Each op succeeds or fails alone."""
    ops = args.get("ops")
    if not isinstance(ops, list):
        raise RequestError("'ops' must be a list")
    results = []
    for op in ops:
        try:
            _apply_op(song, op)
            results.append({"ok": True})
        except Exception as exc:  # report, keep going with the other ops
            results.append({"ok": False, "error": str(exc)})
    return {"results": results}


HANDLERS = {
    "ping": ping,
    "state": state,
    "cues": cues,
    "play": play,
    "continue": resume,
    "stop": stop,
    "jump": jump,
    "play_from": play_from,
    "jump_at": jump_at,
    "cancel_jump": cancel_jump,
    "tempo": tempo,
    "restore_tempo": restore_tempo,
    "loop": loop,
    "tracks": tracks,
    "apply": apply,
    "mixer": mixer,
    "mute": mute,
    "solo": solo,
    "clear_solos": clear_solos,
}
