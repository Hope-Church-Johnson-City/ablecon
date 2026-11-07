"""The control surface object Live loads.

It is a plain class implementing the methods Live calls on a MIDI Remote
Script, so it needs no MIDI ports. Live calls update_display() roughly every
100 ms; that is where the UDP socket is polled and the play position pushed.
"""
import socket

from . import handlers
from .protocol import Dispatcher, changed_message, position_message

LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = 11100
CUE_CHECK_TICKS = 10  # check for locator edits about once a second


class AblconSurface(object):
    def __init__(self, c_instance):
        self._c = c_instance
        self._client = None  # address of the last Ablcon server that talked to us
        self._last_pos = None
        self._last_cues = None
        self._last_mixer = None
        self._tick = 0
        self._sock = None
        version = None
        try:
            app = c_instance.application()
            version = "%s.%s.%s" % (app.get_major_version(), app.get_minor_version(),
                                    app.get_bugfix_version())
        except Exception:
            pass
        self._dispatcher = Dispatcher(c_instance.song(), version, self._log)
        self._open_socket()

    # -- helpers -----------------------------------------------------------
    def _log(self, msg):
        try:
            self._c.log_message("Ablcon: " + msg)
        except Exception:
            pass

    def _open_socket(self):
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind((LISTEN_HOST, LISTEN_PORT))
            sock.setblocking(False)
            self._sock = sock
            self._log("listening on %s:%d" % (LISTEN_HOST, LISTEN_PORT))
        except Exception as exc:
            self._sock = None
            self._log("could not open UDP port %d: %s" % (LISTEN_PORT, exc))

    def _send(self, data, addr):
        try:
            self._sock.sendto(data, addr)
        except Exception as exc:
            self._log("send failed: %s" % exc)

    def _poll(self):
        # Drain everything queued since the last tick.
        for _ in range(200):
            try:
                data, addr = self._sock.recvfrom(65536)
            except (BlockingIOError, socket.error):
                return
            self._client = addr
            for reply in self._dispatcher.handle_datagram(data):
                self._send(reply, addr)

    def _push(self):
        if self._client is None:
            return
        song = self._c.song()
        pos = (round(song.current_song_time, 3), bool(song.is_playing), song.tempo,
               bool(song.loop), song.loop_start, song.loop_length)
        if pos != self._last_pos:
            self._last_pos = pos
            self._send(position_message(song), self._client)
        # Mute changes are checked every tick so the page follows Live quickly.
        mix = handlers.mixer_signature(song)
        if mix != self._last_mixer:
            if self._last_mixer is not None:
                self._send(changed_message("tracks"), self._client)
            self._last_mixer = mix
        self._tick += 1
        if self._tick % CUE_CHECK_TICKS == 0:
            sig = handlers.cue_signature(song)
            if sig != self._last_cues:
                if self._last_cues is not None:
                    self._send(changed_message("cues"), self._client)
                self._last_cues = sig

    # -- methods Live calls --------------------------------------------------
    def update_display(self):
        if self._sock is None:
            return
        try:
            self._poll()
            handlers.apply_pending_jump(self._c.song())
            self._push()
        except Exception as exc:
            self._log("tick error: %s" % exc)

    def disconnect(self):
        if self._sock is not None:
            try:
                self._sock.close()
            except Exception:
                pass
            self._sock = None

    def connect_script_instances(self, instanciated_scripts):
        pass

    def can_lock_to_devices(self):
        return False

    def refresh_state(self):
        pass

    def build_midi_map(self, midi_map_handle):
        pass

    def receive_midi(self, midi_bytes):
        pass

    def suggest_input_port(self):
        return ""

    def suggest_output_port(self):
        return ""

    def suggest_map_mode(self, cc_no, channel):
        return -1
