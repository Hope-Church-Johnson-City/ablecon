"""Draws build/icon.png (1024x1024, transparent corners) with no dependencies."""
import os, struct, zlib

S = 1024
SS = 3  # supersampling per axis for smooth edges

def rrect(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r

SHAPES = [  # drawn in order, last wins
    ((230, 300, 310, 380, 18), (0xF2, 0xB3, 0x3D)),
    ((350, 312, 790, 368, 28), (0xE8, 0xED, 0xF2)),
    ((230, 472, 310, 552, 18), (0x2F, 0xBF, 0x71)),
    ((350, 484, 710, 540, 28), (0xE8, 0xED, 0xF2)),
    ((230, 644, 310, 724, 18), (0x4A, 0xA3, 0xFF)),
    ((350, 656, 750, 712, 28), (0xE8, 0xED, 0xF2)),
]

def sample(x, y):
    if not rrect(x, y, 100, 100, 924, 924, 185):
        return None
    for (x0, y0, x1, y1, r), color in SHAPES:
        if rrect(x, y, x0, y0, x1, y1, r):
            return color
    t = (y - 100) / 824.0
    return tuple(int(a + (b - a) * t) for a, b in zip((0x1F, 0x2A, 0x35), (0x0D, 0x11, 0x15)))

rows = []
for py in range(S):
    row = bytearray([0])
    for px in range(S):
        r = g = b = a = 0
        edge = not (130 < px < 894 and 130 < py < 894) or any(
            x0 - 2 <= px <= x1 + 2 and y0 - 2 <= py <= y1 + 2 for (x0, y0, x1, y1, _), _c in SHAPES)
        n = SS if edge else 1
        for sy in range(n):
            for sx in range(n):
                c = sample(px + (sx + 0.5) / n, py + (sy + 0.5) / n)
                if c:
                    r += c[0]; g += c[1]; b += c[2]; a += 255
        k = n * n
        if a:
            cov = a // 255
            row += bytes((r // cov, g // cov, b // cov, a // k))
        else:
            row += b"\0\0\0\0"
    rows.append(bytes(row))

def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", S, S, 8, 6, 0, 0, 0))
png += chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b"")
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icon.png")
with open(out, "wb") as f:
    f.write(png)
print("wrote", out)
