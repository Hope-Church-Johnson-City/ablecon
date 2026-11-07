"""Tests for the Remote Script code that runs without Live.

    python3 -m unittest discover -s remote_script/tests
"""
import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "fake_live"))

from Ablcon import handlers  # noqa: E402
from Ablcon.osc import decode_message, encode_message  # noqa: E402
from Ablcon.protocol import CHUNK_CHARS, Dispatcher  # noqa: E402
from fake_song import Clip, CuePoint, Song, Track, demo_song, plain_song  # noqa: E402


def request(dispatcher, method, args=None, request_id=1):
    data = encode_message("/ablcon/req", [request_id, method, json.dumps(args or {})])
    datagrams = dispatcher.handle_datagram(data)
    chunks = {}
    total = None
    for d in datagrams:
        address, (rid, part, parts, chunk) = decode_message(d)
        assert address == "/ablcon/res" and rid == request_id
        chunks[part] = chunk
        total = parts
    assert len(chunks) == total
    return json.loads("".join(chunks[i] for i in range(total)))


class OscTests(unittest.TestCase):
    def test_round_trip(self):
        msg = encode_message("/a/b", [1, -2, 0.5, "héllo", True, False, ""])
        self.assertEqual(len(msg) % 4, 0)
        address, args = decode_message(msg)
        self.assertEqual(address, "/a/b")
        self.assertEqual(args, [1, -2, 0.5, "héllo", True, False, ""])

    def test_known_bytes(self):
        # "/x" padded to 4, ",i" padded to 4, then big-endian int 1.
        self.assertEqual(encode_message("/x", [1]), b"/x\x00\x00,i\x00\x00\x00\x00\x00\x01")

    def test_malformed(self):
        with self.assertRaises(ValueError):
            decode_message(b"/x\x00\x00,i\x00\x00\x00")
        with self.assertRaises(ValueError):
            decode_message(b"nope\x00\x00\x00\x00")


class DispatcherTests(unittest.TestCase):
    def setUp(self):
        self.song = demo_song()
        self.d = Dispatcher(self.song, "12.1.0")

    def test_ping(self):
        res = request(self.d, "ping")
        self.assertTrue(res["ok"])
        self.assertEqual(res["result"]["live"], "12.1.0")

    def test_unknown_method_and_bad_args(self):
        self.assertFalse(request(self.d, "explode")["ok"])
        self.assertIn("beats", request(self.d, "jump", {})["error"])

    def test_cues(self):
        res = request(self.d, "cues")["result"]
        self.assertEqual(res["cues"][1], {"name": "*Morning Light", "time": 8.0})
        self.assertEqual(res["songLength"], 408.0)

    def test_transport(self):
        request(self.d, "jump", {"beats": 200})
        request(self.d, "play")
        request(self.d, "tempo", {"bpm": 72})
        self.assertEqual(self.song.current_song_time, 200)
        self.assertTrue(self.song.is_playing)
        self.assertEqual(self.song.tempo, 72)
        request(self.d, "stop")
        self.assertFalse(self.song.is_playing)
        self.assertFalse(request(self.d, "tempo", {"bpm": 5})["ok"])

    def test_loop(self):
        request(self.d, "loop", {"start": 48, "length": 32, "enabled": True})
        self.assertEqual((self.song.loop, self.song.loop_start, self.song.loop_length),
                         (True, 48, 32))
        request(self.d, "loop", {"enabled": False})
        self.assertFalse(self.song.loop)

    def test_tracks_lists_only_clips_in_range(self):
        res = request(self.d, "tracks", {"start": 200, "end": 312})["result"]["tracks"]
        names = [t["name"] for t in res]
        self.assertEqual(names[:3], ["Click [nokey]", "Guide [nokey]", "Stems"])
        keys = res[3]
        self.assertEqual(keys["parents"], ["Stems"])
        self.assertEqual([c["name"] for c in keys["clips"]], ["Keys RW"])
        self.assertEqual(keys["clips"][0]["index"], 1)
        pad = res[4]
        self.assertFalse(pad["clips"][0]["warping"])
        synth = res[5]
        self.assertTrue(synth["isMidi"])
        self.assertEqual(synth["clips"], [])
        self.assertEqual(synth["pitchDevices"][0]["params"][1]["name"], "Pitch")
        self.assertTrue(res[2]["isGroup"])

    def test_apply_ops(self):
        ops = [
            {"kind": "clip", "track": 3, "trackName": "Keys", "clip": 1, "start": 200, "pitch": 2},
            {"kind": "param", "track": 5, "trackName": "Synth", "device": 0, "param": 1, "value": 2},
            {"kind": "clip", "track": 3, "trackName": "Renamed", "clip": 1, "pitch": 2},
            {"kind": "clip", "track": 5, "clip": 0, "pitch": 2},
        ]
        results = request(self.d, "apply", {"ops": ops})["result"]["results"]
        self.assertEqual([r["ok"] for r in results], [True, True, False, False])
        self.assertEqual(self.song.tracks[3].arrangement_clips[1].pitch_coarse, 2)
        self.assertEqual(self.song.tracks[5].devices[0].parameters[1].value, 2)
        self.assertEqual(self.song.tracks[3].arrangement_clips[0].pitch_coarse, 0)

    def test_mixer_and_mute(self):
        tracks = request(self.d, "mixer")["result"]["tracks"]
        self.assertEqual(len(tracks), 6)
        self.assertEqual(tracks[3], {"index": 3, "name": "Keys", "parents": ["Stems"], "isGroup": False,
                                     "muted": False, "mutedViaSolo": False})
        before = handlers.mixer_signature(self.song)
        res = request(self.d, "mute", {"track": 3, "trackName": "Keys", "muted": True})
        self.assertEqual(res["result"], {"muted": True})
        self.assertTrue(self.song.tracks[3].mute)
        self.assertNotEqual(handlers.mixer_signature(self.song), before)
        request(self.d, "mute", {"track": 3, "trackName": "Keys", "muted": False})
        self.assertFalse(self.song.tracks[3].mute)
        self.assertIn("renamed", request(self.d, "mute", {"track": 3, "trackName": "Pad", "muted": True})["error"])
        self.assertIn("muted", request(self.d, "mute", {"track": 3})["error"])
        self.assertFalse(request(self.d, "mute", {"track": 99, "muted": True})["ok"])

    def test_signature_follows_sections_clips(self):
        song = plain_song()
        before = handlers.cue_signature(song)
        song.tracks[0].arrangement_clips[1].name = "Intro 2"
        self.assertNotEqual(handlers.cue_signature(song), before)
        before = handlers.cue_signature(song)
        song.tracks[1].arrangement_clips[0].name = "renamed click"  # not the Sections track
        self.assertEqual(handlers.cue_signature(song), before)

    def test_plain_set_reports_sections_clips(self):
        d = Dispatcher(plain_song())
        tracks = request(d, "tracks", {"start": 0, "end": 1000})["result"]["tracks"]
        sections = tracks[0]
        self.assertEqual(sections["name"], "Sections")
        self.assertEqual([c["name"] for c in sections["clips"]][:3], ["Count Off", "Intro", "Verse 1"])

    def test_large_reply_is_chunked(self):
        cues = [CuePoint("Section %d with a fairly long name" % i, i) for i in range(600)]
        d = Dispatcher(Song(cues, [Track("A", clips=[Clip("x", 0, 4)])]))
        data = encode_message("/ablcon/req", [7, "cues", "{}"])
        datagrams = d.handle_datagram(data)
        self.assertGreater(len(datagrams), 1)
        for dg in datagrams:
            self.assertLess(len(dg), 9216)
        res = request(d, "cues", request_id=7)
        self.assertEqual(len(res["result"]["cues"]), 600)
        self.assertGreater(len(json.dumps(res)), CHUNK_CHARS)

    def test_ignores_garbage(self):
        self.assertEqual(self.d.handle_datagram(b"garbage"), [])
        self.assertEqual(self.d.handle_datagram(encode_message("/other", [1])), [])


if __name__ == "__main__":
    unittest.main()
