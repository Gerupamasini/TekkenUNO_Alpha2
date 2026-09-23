// 実際にサーバーを起動し、Node の WebSocket クライアントでつないで確かめる
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ServerMsg } from "../src/shared/protocol.js";

let proc: ChildProcess;
let port = 0;

before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "uno-client-"));
  writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>t</title>" + "x".repeat(2000));
  proc = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
    env: { ...process.env, PORT: "0", CLIENT_DIR: dir },
    stdio: ["ignore", "pipe", "inherit"],
  });
  port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 15000);
    proc.stdout!.on("data", (d: Buffer) => {
      const m = /listening on :(\d+)/.exec(d.toString());
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
  });
});

after(() => {
  proc.kill("SIGTERM");
});

class Peer {
  ws: WebSocket;
  inbox: ServerMsg[] = [];
  waiters: { pred: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void }[] = [];
  constructor(readonly token: string) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as ServerMsg;
      this.inbox.push(m);
      this.waiters = this.waiters.filter((w) => {
        if (w.pred(m)) {
          w.resolve(m);
          return false;
        }
        return true;
      });
    };
  }
  open() {
    return new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error("ws error"));
    });
  }
  send(o: object) {
    this.ws.send(JSON.stringify(o));
  }
  wait(pred: (m: ServerMsg) => boolean, ms = 5000) {
    const found = this.inbox.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise<ServerMsg>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout waiting message")), ms);
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(t);
          resolve(m);
        },
      });
    });
  }
}

test("HTTP：index.html を圧縮して返す・/healthz", async () => {
  const r = await fetch(`http://127.0.0.1:${port}/`, { headers: { "accept-encoding": "gzip" } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type")!, /text\/html/);
  const h = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(await h.text(), "ok");
  const notFound = await fetch(`http://127.0.0.1:${port}/assets/nope.js`);
  assert.equal(notFound.status, 404);
  const trav = await fetch(`http://127.0.0.1:${port}/..%2f..%2fpackage.json`);
  assert.notEqual(await trav.text(), "", "パスの外は読めず index.html が返る");
});

test("WebSocket：入室→開始→ドローまで通しで動く、ping/pong、大きなメッセージ", async () => {
  const a = new Peer("a".repeat(32));
  const b = new Peer("b".repeat(32));
  await Promise.all([a.open(), b.open()]);
  a.send({ t: "hello", token: a.token, build: "x" });
  b.send({ t: "hello", token: b.token, build: "x" });
  await a.wait((m) => m.t === "hello");
  a.send({ t: "join", key: "wsテスト", name: "A" });
  await a.wait((m) => m.t === "state");
  b.send({ t: "join", key: "WSテスト", name: "B" });
  await b.wait((m) => m.t === "state" && m.s.members.length === 2);
  a.send({ t: "start" });
  const st = (await a.wait((m) => m.t === "state" && m.s.phase === "PLAYING")) as Extract<ServerMsg, { t: "state" }>;
  assert.equal(st.s.game!.hand!.length, 7);
  const g = st.s.game!;
  const turnId = g.seats[g.turn].id;
  const mover = turnId === st.s.you ? a : b;
  const other = mover === a ? b : a;
  other.inbox = [];
  mover.send({ t: "draw" });
  const ev = await other.wait((m) => m.t === "state" && m.ev.some((e) => e.e === "draw"));
  assert.ok(ev);
  // 時刻合わせ
  a.send({ t: "ping", c: 123 });
  const pong = (await a.wait((m) => m.t === "pong")) as Extract<ServerMsg, { t: "pong" }>;
  assert.equal(pong.c, 123);
  // 64KB 超の送信は切断される（サーバーは落ちない）
  const big = new Peer("c".repeat(32));
  await big.open();
  const closed = new Promise<void>((resolve) => (big.ws.onclose = () => resolve()));
  big.ws.send("x".repeat(100_000));
  await closed;
  // その後も他の接続は生きている
  a.send({ t: "ping", c: 7 });
  await a.wait((m) => m.t === "pong" && m.c === 7);
  a.ws.close();
  b.ws.close();
});

test("WebSocket：切断して別の接続で同じ鍵を名乗ると同じ席に戻る", async () => {
  const t = "d".repeat(32);
  const p1 = new Peer(t);
  const p2 = new Peer("e".repeat(32));
  await Promise.all([p1.open(), p2.open()]);
  p1.send({ t: "hello", token: t, build: "x" });
  p2.send({ t: "hello", token: p2.token, build: "x" });
  p1.send({ t: "join", key: "再接続", name: "P1" });
  await p1.wait((m) => m.t === "state");
  p2.send({ t: "join", key: "再接続", name: "P2" });
  await p2.wait((m) => m.t === "state" && m.s.members.length === 2);
  p1.send({ t: "start" });
  const s1 = (await p1.wait((m) => m.t === "state" && m.s.phase === "PLAYING")) as Extract<ServerMsg, { t: "state" }>;
  const handIds = s1.s.game!.hand!.map((c) => c.id).sort();
  p1.ws.close();
  await p2.wait((m) => m.t === "state" && m.s.members.some((x) => x.name === "P1" && !x.online));
  const again = new Peer(t);
  await again.open();
  again.send({ t: "hello", token: t, build: "x" });
  const h = (await again.wait((m) => m.t === "hello")) as Extract<ServerMsg, { t: "hello" }>;
  assert.equal(h.you, s1.s.you);
  const s2 = (await again.wait((m) => m.t === "state")) as Extract<ServerMsg, { t: "state" }>;
  const cur = s2.s.game!.hand!.map((c) => c.id).sort();
  assert.deepEqual(cur, handIds, "同じ手札に戻る");
  assert.equal(s2.s.phase, "PLAYING");
  again.ws.close();
  p2.ws.close();
});
