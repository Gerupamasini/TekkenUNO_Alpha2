// サーバーとの接続。切れたら自動でつなぎ直し、同じ席に戻る
import type { ClientMsg, EventView, RoomView, ServerMsg } from "../shared/protocol.js";
import { S, changed } from "./store.js";

declare const __BUILD_ID__: string;
const BUILD = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";

const TOKEN_KEY = "tekkenuno.token";
const ROOM_KEY = "tekkenuno.room";
const NAME_KEY = "tekkenuno.name";
const RELOAD_KEY = "tekkenuno.reloaded";

function store(kind: "local" | "session") {
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

function makeToken(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** 端末ごとの鍵（再接続で同じ席に戻るため）。保存できない環境ではタブの間だけ有効 */
let memToken = "";
export function token(): string {
  const ls = store("local");
  let t = ls?.getItem(TOKEN_KEY) ?? memToken;
  if (!/^[0-9a-f]{32}$/.test(t)) {
    t = makeToken();
    try {
      ls?.setItem(TOKEN_KEY, t);
    } catch {
      /* 保存できなくても続ける */
    }
  }
  memToken = t;
  return t;
}

export function savedName(): string {
  return store("local")?.getItem(NAME_KEY) ?? "";
}

export interface JoinInfo {
  key: string;
  name: string;
  spectate: boolean;
}

function rememberRoom(j: JoinInfo | null) {
  try {
    const ss = store("session");
    if (j) {
      ss?.setItem(ROOM_KEY, JSON.stringify(j));
      store("local")?.setItem(NAME_KEY, j.name);
    } else ss?.removeItem(ROOM_KEY);
  } catch {
    /* noop */
  }
}

function rememberedRoom(): JoinInfo | null {
  try {
    const raw = store("session")?.getItem(ROOM_KEY);
    return raw ? (JSON.parse(raw) as JoinInfo) : null;
  } catch {
    return null;
  }
}

type StateHandler = (view: RoomView, ev: EventView[]) => void;
type Handlers = { state: StateHandler; error: (m: string) => void; out: (why: "left" | "kicked") => void };

let ws: WebSocket | null = null;
let handlers: Handlers;
let retry = 0;
let retryTimer = 0;
let pingTimer = 0;
let lastMsgAt = 0;
let slowTimer = 0;
const samples: { rtt: number; off: number }[] = [];

export function initNet(h: Handlers) {
  handlers = h;
  connect();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") wake();
  });
  window.addEventListener("online", wake);
  window.addEventListener("pageshow", wake);
}

/** スマホの復帰時など：死んだ接続を見つけてすぐつなぎ直す */
function wake() {
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    connectSoon(0);
    return;
  }
  if (ws.readyState === WebSocket.OPEN) {
    const sentAt = Date.now();
    sendRaw({ t: "ping", c: sentAt });
    setTimeout(() => {
      if (lastMsgAt < sentAt && ws && ws.readyState === WebSocket.OPEN) ws.close();
    }, 3000);
  }
}

function connectSoon(ms: number) {
  clearTimeout(retryTimer);
  retryTimer = window.setTimeout(connect, ms);
}

function connect() {
  clearTimeout(retryTimer);
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  S.conn = "connecting";
  clearTimeout(slowTimer);
  slowTimer = window.setTimeout(() => {
    if (S.conn !== "open") {
      S.slow = true;
      changed();
    }
  }, 2500);
  changed();
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const sock = new WebSocket(`${proto}//${location.host}/ws`);
  ws = sock;
  sock.onopen = () => {
    if (ws !== sock) return;
    retry = 0;
    S.conn = "open";
    S.slow = false;
    clearTimeout(slowTimer);
    lastMsgAt = Date.now();
    sendRaw({ t: "hello", token: token(), build: BUILD });
    startPings();
    changed();
  };
  sock.onmessage = (e) => {
    if (ws !== sock) return;
    lastMsgAt = Date.now();
    let msg: ServerMsg;
    try {
      msg = JSON.parse(String(e.data));
    } catch {
      return;
    }
    onMessage(msg);
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    S.conn = "closed";
    S.busy = false;
    clearInterval(pingTimer);
    changed();
    const wait = [250, 800, 1500, 2500, 4000][Math.min(retry, 4)];
    retry++;
    connectSoon(wait);
  };
  sock.onerror = () => {
    /* onclose で処理する */
  };
}

function startPings() {
  clearInterval(pingTimer);
  let n = 0;
  const ping = () => {
    sendRaw({ t: "ping", c: Date.now() });
    n++;
    if (n === 4) {
      clearInterval(pingTimer);
      pingTimer = window.setInterval(ping, 15_000);
    }
  };
  ping();
  pingTimer = window.setInterval(ping, 1_000);
}

function onMessage(msg: ServerMsg) {
  switch (msg.t) {
    case "hello": {
      if (!samples.length) S.offset = msg.now - Date.now();
      // 新しい版が公開されていたら1回だけ読み込み直す
      if (msg.build !== BUILD && BUILD !== "dev" && msg.build !== "dev") {
        const ss = store("session");
        if (ss?.getItem(RELOAD_KEY) !== msg.build) {
          ss?.setItem(RELOAD_KEY, msg.build);
          location.reload();
          return;
        }
      }
      if (msg.you === null) {
        const j = rememberedRoom();
        if (j) sendRaw({ t: "join", key: j.key, name: j.name, spectate: j.spectate });
        else if (S.view) {
          S.view = null;
          changed();
        }
      }
      return;
    }
    case "pong": {
      const t = Date.now();
      const rtt = t - msg.c;
      if (rtt < 0 || rtt > 10_000) return;
      samples.push({ rtt, off: msg.s + rtt / 2 - t });
      if (samples.length > 8) samples.shift();
      const best = samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
      S.offset = best.off;
      return;
    }
    case "state":
      S.busy = false;
      handlers.state(msg.s, msg.ev);
      return;
    case "err":
      S.busy = false;
      handlers.error(msg.m);
      changed();
      return;
    case "out":
      rememberRoom(null);
      S.view = null;
      S.busy = false;
      handlers.out(msg.why);
      changed();
      return;
  }
}

function sendRaw(msg: ClientMsg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/** 操作を送る。つながっていなければ知らせる */
export function send(msg: ClientMsg): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    handlers.error("通信が切れています。つなぎ直しています…");
    return false;
  }
  ws.send(JSON.stringify(msg));
  return true;
}

export function join(j: JoinInfo) {
  rememberRoom(j);
  if (!send({ t: "join", key: j.key, name: j.name, spectate: j.spectate })) connectSoon(0);
}

export function leaveRoom() {
  send({ t: "leave" });
}
