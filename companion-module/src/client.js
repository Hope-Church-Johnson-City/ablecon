// Connection from the Companion module to Ablecon, over the same WebSocket the
// Ablecon page uses. Keeps the latest state and position, sends commands and
// reconnects by itself when Ablecon restarts or the network drops.

const RECONNECT_MS = 2000;
const COMMAND_TIMEOUT_MS = 5000;

export class AbleconClient {
  /**
   * @param {{ host: string, port: number, onChange?: () => void, onStatus?: (connected: boolean, error?: string) => void, onNotice?: (text: string, level: string) => void, WebSocketImpl?: typeof WebSocket }} opts
   */
  constructor(opts) {
    this.host = opts.host;
    this.port = opts.port;
    this.onChange = opts.onChange ?? (() => {});
    this.onStatus = opts.onStatus ?? (() => {});
    this.onNotice = opts.onNotice ?? (() => {});
    this.WebSocketImpl = opts.WebSocketImpl ?? globalThis.WebSocket;
    /** Latest snapshot from Ablecon (setlist rows, tracks, settings, ...), or null before the first one. */
    this.state = null;
    /** Latest playhead position. */
    this.position = null;
    this.connected = false;
    this.socket = null;
    this.stopped = false;
    this.nextId = 1;
    this.pending = new Map();
    this.timer = null;
  }

  get url() {
    const host = this.host.includes(':') && !this.host.startsWith('[') ? `[${this.host}]` : this.host;
    return `ws://${host}:${this.port}/ws`;
  }

  start() {
    this.stopped = false;
    this.open();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // already closed
      }
    }
    this.socket = null;
    this.failPending('disconnected');
  }

  open() {
    if (this.stopped) return;
    let socket;
    try {
      socket = new this.WebSocketImpl(this.url);
    } catch (err) {
      this.setConnected(false, String(err?.message ?? err));
      this.retry();
      return;
    }
    this.socket = socket;
    socket.addEventListener('open', () => this.setConnected(true));
    socket.addEventListener('message', (ev) => this.onMessage(ev.data));
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.failPending('lost connection to Ablecon');
      this.setConnected(false, `Can't reach Ablecon at ${this.host}:${this.port}`);
      this.retry();
    });
    socket.addEventListener('error', () => {
      // 'close' follows and handles the retry
    });
  }

  retry() {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.open();
    }, RECONNECT_MS);
  }

  setConnected(value, error) {
    if (value === this.connected && !error) return;
    this.connected = value;
    this.onStatus(value, error);
  }

  onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.type === 'state') {
      this.state = msg.state;
      this.position = msg.state.position;
      this.onChange();
    } else if (msg.type === 'position') {
      this.position = msg.position;
      this.onChange();
    } else if (msg.type === 'notice') {
      this.onNotice(msg.notice?.text ?? '', msg.notice?.level ?? 'info');
    } else if (msg.type === 'result') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve();
      else p.reject(new Error(msg.error || 'Ablecon refused the command'));
    }
  }

  failPending(reason) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  /** Send a command to Ablecon; resolves when Ablecon has done it. */
  send(action, extra = {}) {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return Promise.reject(new Error('Not connected to Ablecon'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Ablecon did not answer "${action}"`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, action, ...extra }));
    });
  }
}
