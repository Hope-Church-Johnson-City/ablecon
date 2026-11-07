"""Minimal OSC 1.0 message encoder/decoder.

Only what Ablecon needs: messages (no bundles) with int32 (i), float32 (f),
string (s), double (d), true (T) and false (F) arguments.
Written for Ablecon; no third-party code.
"""
import struct


def _pad(data):
    # OSC strings/blobs are padded with NULs to a multiple of 4 bytes.
    return data + b"\x00" * ((4 - len(data) % 4) % 4)


def _encode_string(text):
    return _pad(text.encode("utf-8") + b"\x00")


def encode_message(address, args=()):
    tags = ","
    payload = b""
    for value in args:
        if value is True:
            tags += "T"
        elif value is False:
            tags += "F"
        elif isinstance(value, int):
            tags += "i"
            payload += struct.pack(">i", value)
        elif isinstance(value, float):
            tags += "f"
            payload += struct.pack(">f", value)
        elif isinstance(value, str):
            tags += "s"
            payload += _encode_string(value)
        else:
            raise TypeError("unsupported OSC argument: %r" % (value,))
    return _encode_string(address) + _encode_string(tags) + payload


def _read_string(data, offset):
    end = data.index(b"\x00", offset)
    text = data[offset:end].decode("utf-8")
    offset = end + 1
    offset += (4 - offset % 4) % 4
    return text, offset


def decode_message(data):
    """Return (address, [args]). Raises ValueError on malformed input."""
    try:
        address, offset = _read_string(data, 0)
        if not address.startswith("/"):
            raise ValueError("not an OSC message")
        if offset >= len(data):
            return address, []
        tags, offset = _read_string(data, offset)
        if not tags.startswith(","):
            raise ValueError("missing type tag string")
        args = []
        for tag in tags[1:]:
            if tag == "i":
                args.append(struct.unpack(">i", data[offset:offset + 4])[0])
                offset += 4
            elif tag == "f":
                args.append(struct.unpack(">f", data[offset:offset + 4])[0])
                offset += 4
            elif tag == "d":
                args.append(struct.unpack(">d", data[offset:offset + 8])[0])
                offset += 8
            elif tag == "s":
                value, offset = _read_string(data, offset)
                args.append(value)
            elif tag == "T":
                args.append(True)
            elif tag == "F":
                args.append(False)
            else:
                raise ValueError("unsupported OSC type tag %r" % tag)
        return address, args
    except (struct.error, IndexError, UnicodeDecodeError) as exc:
        raise ValueError("malformed OSC message: %s" % exc)
