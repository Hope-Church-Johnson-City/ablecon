"""Ablcon wire protocol (OSC over UDP on localhost).

Requests  (server -> Live):  /ablcon/req  <id:i> <method:s> <args-json:s>
Replies   (Live -> server):  /ablcon/res  <id:i> <part:i> <parts:i> <json-chunk:s>
Pushes    (Live -> server):  /ablcon/pos  <beats:f> <playing:i> <tempo:f>
                                          <loop:i> <loopStart:f> <loopLength:f>
                             /ablcon/changed <what:s>   ("cues" or "tracks")

A reply body is JSON: {"ok": true, "result": ...} or {"ok": false, "error": "..."}.
It is ASCII-only (non-ASCII is \\u-escaped) and split into chunks so every
datagram stays well under macOS's default 9216-byte UDP limit.
"""
import json

from . import handlers
from .osc import decode_message, encode_message

CHUNK_CHARS = 6000


def split_reply(request_id, body):
    text = json.dumps(body, ensure_ascii=True, separators=(",", ":"))
    chunks = [text[i:i + CHUNK_CHARS] for i in range(0, len(text), CHUNK_CHARS)] or [""]
    return [
        encode_message("/ablcon/res", [int(request_id), part, len(chunks), chunk])
        for part, chunk in enumerate(chunks)
    ]


def position_message(song):
    return encode_message("/ablcon/pos", [
        float(song.current_song_time),
        1 if song.is_playing else 0,
        float(song.tempo),
        1 if song.loop else 0,
        float(song.loop_start),
        float(song.loop_length),
    ])


def changed_message(what):
    return encode_message("/ablcon/changed", [what])


class Dispatcher(object):
    def __init__(self, song, app_version=None, log=None):
        self._song = song
        self._app_version = app_version
        self._log = log or (lambda msg: None)

    def handle_datagram(self, data):
        """Return a list of datagrams to send back to the sender."""
        try:
            address, args = decode_message(data)
        except ValueError as exc:
            self._log("ignored bad datagram: %s" % exc)
            return []
        if address != "/ablcon/req" or len(args) < 2:
            self._log("ignored message %s" % address)
            return []
        request_id, method = args[0], args[1]
        raw_args = args[2] if len(args) > 2 else "{}"
        try:
            call_args = json.loads(raw_args) if raw_args else {}
            if not isinstance(call_args, dict):
                raise handlers.RequestError("arguments must be a JSON object")
            handler = handlers.HANDLERS.get(method)
            if handler is None:
                raise handlers.RequestError("unknown method '%s'" % method)
            if method == "ping":
                result = handler(self._song, call_args, self._app_version)
            else:
                result = handler(self._song, call_args)
            body = {"ok": True, "result": result}
        except Exception as exc:
            body = {"ok": False, "error": str(exc)}
        return split_reply(request_id, body)
