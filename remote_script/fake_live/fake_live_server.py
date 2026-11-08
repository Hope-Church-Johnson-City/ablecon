"""Run the real Ablecon request handlers against a fake Live set over UDP.

    python3 remote_script/fake_live/fake_live_server.py [--port 11100]

Lets you try the server and web UI without Ableton Live. The playhead moves
in real time while "playing". It speaks exactly the protocol the Remote Script
does, because it uses the same Dispatcher code.
"""
import argparse
import os
import socket
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))  # remote_script/ -> import Ablecon
sys.path.insert(0, HERE)

from Ablecon import handlers  # noqa: E402
from Ablecon.protocol import Dispatcher, changed_message, position_message  # noqa: E402
from fake_song import demo_song, plain_song  # noqa: E402


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=11100)
    parser.add_argument("--tick", type=float, default=0.1)
    parser.add_argument("--set", choices=["plain", "marked"], default="plain",
                        help="plain: song locators + STOP + Sections track (default); "
                             "marked: *Song locators with section locators")
    parser.add_argument("--audio-dir", default=None,
                        help="plain set only: stems play <dir>/<song>.wav (for waveform checks)")
    opts = parser.parse_args()

    song = plain_song(opts.audio_dir) if opts.set == "plain" else demo_song()
    dispatcher = Dispatcher(song, "fake", lambda m: print(m, file=sys.stderr))
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("127.0.0.1", opts.port))
    sock.settimeout(opts.tick)
    print("fake Live listening on 127.0.0.1:%d" % opts.port, flush=True)

    client = None
    last_pos = None
    last_cues = handlers.cue_signature(song)
    last_mixer = handlers.mixer_signature(song)
    last = time.monotonic()
    while True:
        try:
            data, addr = sock.recvfrom(65536)
            client = addr
            for reply in dispatcher.handle_datagram(data):
                sock.sendto(reply, addr)
        except socket.timeout:
            pass
        now = time.monotonic()
        handlers.apply_pending_jump(song)
        handlers.run_scheduled_jump(song, opts.tick)
        song.advance(now - last)
        last = now
        if client is not None:
            pos = (round(song.current_song_time, 3), song.is_playing, song.tempo,
                   song.loop, song.loop_start, song.loop_length)
            if pos != last_pos:
                last_pos = pos
                sock.sendto(position_message(song), client)
            mix = handlers.mixer_signature(song)
            if mix != last_mixer:
                last_mixer = mix
                sock.sendto(changed_message("tracks"), client)
            sig = handlers.cue_signature(song)
            if sig != last_cues:
                last_cues = sig
                sock.sendto(changed_message("cues"), client)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
