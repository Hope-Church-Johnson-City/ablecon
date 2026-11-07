// Talks to the Ablecon Remote Script inside Live over OSC/UDP on localhost.
// Protocol: see remote_script/Ablecon/protocol.py.

import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { argValues, decodeMessage, encodeMessage, int, str } from './osc.ts';
import type { Position } from './types.ts';

export interface LiveClientOptions {
  host?: string;
  port?: number;
  timeoutMs?: number;
  heartbeatMs?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  chunks: string[];
  received: number;
}

export interface LiveClientEvents {
  position: [Position];
  changed: [string];
  connection: [boolean];
}

export class LiveClient extends EventEmitter<LiveClientEvents> {
  readonly host: string;
  readonly port: number;
  private readonly timeoutMs: number;
  private readonly heartbeatMs: number;
  private socket: dgram.Socket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private heartbeat: NodeJS.Timeout | null = null;
  connected = false;
  liveVersion: string | null = null;
  scriptVersion: string | null = null; // version of the Remote Script running in Live

  constructor(opts: LiveClientOptions = {}) {
    super();
    this.host = opts.host ?? '127.0.0.1';
    this.port = opts.port ?? 11100;
    this.timeoutMs = opts.timeoutMs ?? 2000;
    this.heartbeatMs = opts.heartbeatMs ?? 1000;
  }

  async start(): Promise<void> {
    const socket = dgram.createSocket('udp4');
    this.socket = socket;
    socket.on('message', (buf) => this.onMessage(buf));
    socket.on('error', () => {
      /* ICMP "port unreachable" when Live isn't running; heartbeat handles it */
    });
    await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
    const beat = () => {
      this.call<{ live: string | null; version?: string }>('ping')
        .then((r) => {
          this.liveVersion = r.live;
          this.scriptVersion = r.version ?? null;
          this.setConnected(true);
        })
        .catch(() => this.setConnected(false));
    };
    beat();
    this.heartbeat = setInterval(beat, this.heartbeatMs);
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('client stopped'));
      this.pending.delete(id);
    }
    this.socket?.close();
    this.socket = null;
  }

  private setConnected(value: boolean): void {
    if (value !== this.connected) {
      this.connected = value;
      this.emit('connection', value);
    }
  }

  /** Call a Remote Script method and resolve with its result. */
  call<T = unknown>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error('Live client is not started'));
    const id = this.nextId;
    this.nextId = this.nextId >= 0x7fffffff ? 1 : this.nextId + 1;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Live did not answer "${method}" (is the Ablecon control surface enabled?)`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, chunks: [], received: 0 });
      const msg = encodeMessage('/ablecon/req', [int(id), str(method), str(JSON.stringify(args))]);
      socket.send(msg, this.port, this.host);
    });
  }

  private onMessage(buf: Buffer): void {
    let address: string;
    let values: Array<number | string | boolean>;
    try {
      const msg = decodeMessage(buf);
      address = msg.address;
      values = argValues(msg);
    } catch {
      return;
    }
    if (address === '/ablecon/res') this.onReply(values);
    else if (address === '/ablecon/pos') this.onPosition(values);
    else if (address === '/ablecon/changed') this.emit('changed', String(values[0] ?? ''));
  }

  private onReply(values: Array<number | string | boolean>): void {
    const [id, part, parts, chunk] = values as [number, number, number, string];
    const p = this.pending.get(id);
    if (!p || typeof chunk !== 'string') return;
    if (p.chunks[part] === undefined) {
      p.chunks[part] = chunk;
      p.received++;
    }
    if (p.received < parts) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    try {
      const body = JSON.parse(p.chunks.join('')) as { ok: boolean; result?: unknown; error?: string };
      if (body.ok) p.resolve(body.result);
      else p.reject(new Error(body.error ?? 'Live reported an error'));
    } catch (err) {
      p.reject(new Error(`bad reply from Live: ${(err as Error).message}`));
    }
  }

  private onPosition(values: Array<number | string | boolean>): void {
    const [beats, playing, tempo, loop, loopStart, loopLength] = values as number[];
    this.setConnected(true);
    this.emit('position', {
      beats,
      playing: playing === 1,
      tempo,
      loop: { enabled: loop === 1, start: loopStart, length: loopLength },
    });
  }
}
