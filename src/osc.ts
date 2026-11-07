// Minimal OSC 1.0 message codec (messages only, no bundles).
// Supported argument types: int32 (i), float32 (f), float64 (d), string (s), true (T), false (F).

export type OscArg =
  | { type: 'i'; value: number }
  | { type: 'f'; value: number }
  | { type: 'd'; value: number }
  | { type: 's'; value: string }
  | { type: 'T' }
  | { type: 'F' };

export interface OscMessage {
  address: string;
  args: OscArg[];
}

export const int = (value: number): OscArg => ({ type: 'i', value });
export const float = (value: number): OscArg => ({ type: 'f', value });
export const str = (value: string): OscArg => ({ type: 's', value });

function paddedString(text: string): Buffer {
  const raw = Buffer.from(text, 'utf8');
  const size = Math.ceil((raw.length + 1) / 4) * 4;
  const out = Buffer.alloc(size); // zero-filled: terminator + padding
  raw.copy(out);
  return out;
}

export function encodeMessage(address: string, args: OscArg[] = []): Buffer {
  if (!address.startsWith('/')) throw new Error(`OSC address must start with "/": ${address}`);
  const parts: Buffer[] = [paddedString(address), paddedString(',' + args.map((a) => a.type).join(''))];
  for (const arg of args) {
    switch (arg.type) {
      case 'i': {
        if (!Number.isInteger(arg.value) || arg.value < -0x80000000 || arg.value > 0x7fffffff) {
          throw new Error(`not an int32: ${arg.value}`);
        }
        const b = Buffer.alloc(4);
        b.writeInt32BE(arg.value);
        parts.push(b);
        break;
      }
      case 'f': {
        const b = Buffer.alloc(4);
        b.writeFloatBE(arg.value);
        parts.push(b);
        break;
      }
      case 'd': {
        const b = Buffer.alloc(8);
        b.writeDoubleBE(arg.value);
        parts.push(b);
        break;
      }
      case 's':
        parts.push(paddedString(arg.value));
        break;
      case 'T':
      case 'F':
        break;
    }
  }
  return Buffer.concat(parts);
}

function readString(buf: Buffer, offset: number): [string, number] {
  const end = buf.indexOf(0, offset);
  if (end < 0) throw new Error('unterminated OSC string');
  const text = buf.toString('utf8', offset, end);
  return [text, Math.ceil((end + 1) / 4) * 4];
}

function need(buf: Buffer, offset: number, size: number): void {
  if (offset + size > buf.length) throw new Error('OSC message truncated');
}

export function decodeMessage(buf: Buffer): OscMessage {
  const [address, afterAddress] = readString(buf, 0);
  if (!address.startsWith('/')) throw new Error('not an OSC message');
  if (afterAddress >= buf.length) return { address, args: [] };
  const [tags, start] = readString(buf, afterAddress);
  if (!tags.startsWith(',')) throw new Error('missing OSC type tags');
  let offset = start;
  const args: OscArg[] = [];
  for (const tag of tags.slice(1)) {
    switch (tag) {
      case 'i':
        need(buf, offset, 4);
        args.push({ type: 'i', value: buf.readInt32BE(offset) });
        offset += 4;
        break;
      case 'f':
        need(buf, offset, 4);
        args.push({ type: 'f', value: buf.readFloatBE(offset) });
        offset += 4;
        break;
      case 'd':
        need(buf, offset, 8);
        args.push({ type: 'd', value: buf.readDoubleBE(offset) });
        offset += 8;
        break;
      case 's': {
        const [value, next] = readString(buf, offset);
        args.push({ type: 's', value });
        offset = next;
        break;
      }
      case 'T':
        args.push({ type: 'T' });
        break;
      case 'F':
        args.push({ type: 'F' });
        break;
      default:
        throw new Error(`unsupported OSC type tag "${tag}"`);
    }
  }
  return { address, args };
}

/** Plain JS values of a message's arguments (T/F become booleans). */
export function argValues(msg: OscMessage): Array<number | string | boolean> {
  return msg.args.map((a) => (a.type === 'T' ? true : a.type === 'F' ? false : a.value));
}
