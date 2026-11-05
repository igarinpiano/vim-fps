// Connections. Both kinds look the same to the game: send(obj), and
// onmessage(msg) / onclose(reason) callbacks.

export const PROTOCOL = 3;

/// WebSocket to a CLI host. The page's own host when url is omitted.
export class WsConnection {
  constructor(url) {
    this.onmessage = () => {};
    this.onclose = () => {};
    this.onopen = () => {};
    this.closed = false;
    this.ws = new WebSocket(url);
    this.ws.onopen = () => this.onopen();
    this.stats = { bytesIn: 0, bytesOut: 0, msgsIn: 0, msgsOut: 0, kind: 'WebSocket', url };
    this.ws.onmessage = (e) => {
      this.stats.bytesIn += e.data.length;
      this.stats.msgsIn += 1;
      try {
        this.onmessage(JSON.parse(e.data));
      } catch (err) {
        console.error(err);
      }
    };
    this.ws.onclose = () => {
      if (!this.closed) {
        this.closed = true;
        this.onclose('サーバーとの接続が切れました');
      }
    };
    this.ws.onerror = () => {};
  }

  send(obj) {
    if (this.ws.readyState === WebSocket.OPEN) {
      const text = JSON.stringify(obj);
      this.stats.bytesOut += text.length;
      this.stats.msgsOut += 1;
      this.ws.send(text);
    }
  }

  close() {
    this.closed = true;
    this.ws.close();
  }
}

let wasmModule = null;

async function loadWasm() {
  if (!wasmModule) {
    const url = new URL('../pkg/vimfps.wasm', import.meta.url);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`練習モードのデータ (pkg/vimfps.wasm) を読めません: ${res.status}`);
    const bytes = await res.arrayBuffer();
    wasmModule = await WebAssembly.compile(bytes);
  }
  const { exports } = await WebAssembly.instantiate(wasmModule, {});
  return exports;
}

/// Practice mode: the server's simulation running in the page (wasm).
export class LocalConnection {
  /// The game's numbers without joining (for :spec on the title screen).
  static async specs() {
    const ex = await loadWasm();
    const n = ex.vf_specs();
    const ptr = ex.vf_out();
    return JSON.parse(new TextDecoder().decode(new Uint8Array(ex.memory.buffer, ptr, n)));
  }

  /// mode: { range, noRespawn }
  static async create(seed, bots, mode = {}) {
    const ex = await loadWasm();
    return new LocalConnection(ex, seed, bots, mode);
  }

  constructor(ex, seed, bots, mode = {}) {
    this.ex = ex;
    this.onmessage = () => {};
    this.onclose = () => {};
    this.onopen = () => {};
    this.closed = false;
    this.enc = new TextEncoder();
    this.dec = new TextDecoder();
    this.stats = { bytesIn: 0, bytesOut: 0, msgsIn: 0, msgsOut: 0, kind: 'ブラウザ内 (wasm)', url: null };
    const bits = (mode.range ? 1 : 0) | (mode.noRespawn ? 2 : 0);
    if (mode.custom && ex.vf_new_custom) ex.vf_new_custom(seed >>> 0, bots >>> 0, bits, mode.skill || 3, mode.time || 600, mode.frags || 0);
    else if (bits && ex.vf_new_mode) ex.vf_new_mode(seed >>> 0, bots >>> 0, bits);
    else ex.vf_new(seed >>> 0, bots >>> 0);
    this.last = performance.now();
    this.timer = setInterval(() => this.tick(), 1000 / 60);
    setTimeout(() => this.onopen(), 0);
  }

  send(obj) {
    if (this.closed) return;
    const bytes = this.enc.encode(JSON.stringify(obj));
    this.stats.bytesOut += bytes.length;
    this.stats.msgsOut += 1;
    const ptr = this.ex.vf_in(bytes.length);
    new Uint8Array(this.ex.memory.buffer, ptr, bytes.length).set(bytes);
    this.ex.vf_send(bytes.length);
  }

  tick() {
    if (this.closed) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const n = this.ex.vf_tick(dt);
    if (!n) return;
    const ptr = this.ex.vf_out();
    const text = this.dec.decode(new Uint8Array(this.ex.memory.buffer, ptr, n));
    this.stats.bytesIn += n;
    const msgs = JSON.parse(text);
    this.stats.msgsIn += msgs.length;
    for (const m of msgs) this.onmessage(m);
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
  }
}

/// "https://x.trycloudflare.com/#pw=abc", "192.168.1.5:7777", "" (this page)
/// → { ws: "wss://.../ws", password }.
export function parseServerUrl(input, here) {
  let s = (input || '').trim();
  let password = null;
  if (!s) s = here.href;
  if (!/^[a-z]+:\/\//i.test(s)) s = (here.protocol === 'https:' ? 'https://' : 'http://') + s;
  const u = new URL(s);
  const m = u.hash.match(/pw=([^&]*)/);
  if (m) password = decodeURIComponent(m[1]);
  const secure = u.protocol === 'https:' || u.protocol === 'wss:';
  return { ws: `${secure ? 'wss' : 'ws'}://${u.host}/ws`, password, secure };
}
