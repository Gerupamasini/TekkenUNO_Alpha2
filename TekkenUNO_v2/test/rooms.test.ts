// 部屋・ホスト・再接続・成績のテスト（サーバーの中身を直接呼ぶ）
import { test } from "node:test";
import assert from "node:assert/strict";
import { type Client, Lobby, normalizeKey, cleanName } from "../src/server/rooms.js";
import type { RoomView, ServerMsg } from "../src/shared/protocol.js";
import { handPoints } from "../src/shared/cards.js";

let clock = 1_000_000;
function makeLobby() {
  let seed = 42;
  const rng = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x80000000;
  };
  return new Lobby({ now: () => clock, rng, build: "test" });
}

class FakeClient implements Client {
  token: string | null = null;
  tokens = 1000;
  tokensAt = 0;
  inbox: ServerMsg[] = [];
  send(msg: ServerMsg) {
    this.inbox.push(JSON.parse(JSON.stringify(msg)));
  }
  get state(): RoomView | null {
    for (let i = this.inbox.length - 1; i >= 0; i--) {
      const m = this.inbox[i];
      if (m.t === "state") return m.s;
      if (m.t === "out") return null;
    }
    return null;
  }
  lastErr() {
    for (let i = this.inbox.length - 1; i >= 0; i--) {
      const m = this.inbox[i];
      if (m.t === "err") return m.m;
    }
    return null;
  }
}

let tok = 0;
function connect(lobby: Lobby, token?: string) {
  const c = new FakeClient();
  const t = token ?? (tok++).toString(16).padStart(32, "0");
  lobby.handle(c, JSON.stringify({ t: "hello", token: t, build: "test" }));
  lobby.flushAll();
  return c;
}
function send(lobby: Lobby, c: FakeClient, msg: object) {
  c.tokens = 1000;
  lobby.handle(c, JSON.stringify(msg));
  lobby.flushAll();
}

test("合言葉の正規化と名前の掃除", () => {
  assert.equal(normalizeKey("  Ｔｅｋｋｅｎ  "), "tekken");
  assert.equal(normalizeKey(""), null);
  assert.equal(normalizeKey("x".repeat(40)), null);
  assert.equal(cleanName("  あいうえおかきくけこさしすせ "), "あいうえおかきくけこさし");
  assert.equal(cleanName("\u0000"), "名無し");
});

test("同じ合言葉で同じ部屋、最初の人がホスト、同名には番号", () => {
  const lobby = makeLobby();
  const a = connect(lobby);
  const b = connect(lobby);
  send(lobby, a, { t: "join", key: "鉄研", name: "たろう" });
  send(lobby, b, { t: "join", key: " 鉄研 ", name: "たろう" });
  const sa = a.state!;
  assert.equal(sa.members.length, 2);
  assert.equal(sa.host, sa.you);
  assert.deepEqual(
    sa.members.map((m) => m.name),
    ["たろう", "たろう(2)"],
  );
});

function roomWith(n: number) {
  const lobby = makeLobby();
  const cs = Array.from({ length: n }, () => connect(lobby));
  cs.forEach((c, i) => send(lobby, c, { t: "join", key: "room", name: `P${i}` }));
  return { lobby, cs };
}

test("STARTはホストだけ、2人以上必要", () => {
  const { lobby, cs } = roomWith(1);
  send(lobby, cs[0], { t: "start" });
  assert.match(cs[0].lastErr()!, /2人以上/);
  const b = connect(lobby);
  send(lobby, b, { t: "join", key: "room", name: "B" });
  send(lobby, b, { t: "start" });
  assert.match(b.lastErr()!, /ホスト/);
  send(lobby, cs[0], { t: "start" });
  assert.equal(cs[0].state!.phase, "PLAYING");
  assert.equal(cs[0].state!.game!.hand!.length, 7);
  assert.equal(b.state!.game!.hand!.length, 7);
});

test("ゲーム中の入室は観戦、観戦者に手札は見えない、ゲーム中は退室不可", () => {
  const { lobby, cs } = roomWith(2);
  send(lobby, cs[0], { t: "start" });
  const s = connect(lobby);
  send(lobby, s, { t: "join", key: "room", name: "S" });
  assert.equal(s.state!.role, "spectator");
  assert.equal(s.state!.game!.hand, null);
  send(lobby, cs[1], { t: "leave" });
  assert.match(cs[1].lastErr()!, /退室できません/);
});

test("再接続：同じ鍵で戻ると同じ席・同じ手札", () => {
  const { lobby, cs } = roomWith(2);
  send(lobby, cs[0], { t: "start" });
  const token = cs[1].token!;
  const hand = cs[1].state!.game!.hand!.map((c) => c.id);
  lobby.disconnect(cs[1]);
  lobby.flushAll();
  const seat = cs[0].state!.game!.seats.find((x) => x.id === cs[1].state!.you)!;
  assert.equal(seat.online, false);
  const again = connect(lobby, token);
  const st = again.state!;
  assert.deepEqual(
    st.game!.hand!.map((c) => c.id),
    hand,
  );
  assert.equal(st.role, "player");
});

test("ホストが20秒切断すると接続中の人に移る。全員切断中は移らない", () => {
  const { lobby, cs } = roomWith(3);
  const host = cs[0].state!.host;
  lobby.disconnect(cs[0]);
  clock += 21_000;
  lobby.tick();
  assert.notEqual(cs[1].state!.host, host);
  const newHost = cs[1].state!.host;
  lobby.disconnect(cs[1]);
  lobby.disconnect(cs[2]);
  clock += 30_000;
  lobby.tick();
  lobby.tick();
  const room = [...lobby.rooms.values()][0];
  assert.equal(room.hostId, newHost, "全員切断中はホストが行ったり来たりしない");
});

test("全員の接続が切れて10分で部屋が消える", () => {
  const { lobby, cs } = roomWith(2);
  cs.forEach((c) => lobby.disconnect(c));
  clock += 9 * 60_000;
  lobby.tick();
  assert.equal(lobby.rooms.size, 1);
  clock += 2 * 60_000;
  lobby.tick();
  assert.equal(lobby.rooms.size, 0);
});

test("キック：ロビーでは退室。キックされた端末も入り直せる", () => {
  const { lobby, cs } = roomWith(3);
  const target = cs[2].state!.you;
  send(lobby, cs[1], { t: "kick", id: target });
  assert.match(cs[1].lastErr()!, /ホスト/);
  send(lobby, cs[0], { t: "kick", id: target });
  assert.equal(cs[2].state, null);
  assert.ok(cs[2].inbox.some((m) => m.t === "out" && m.why === "kicked"));
  assert.equal(cs[0].state!.members.length, 2);
  send(lobby, cs[2], { t: "join", key: "room", name: "P2" });
  const st = cs[2].state!;
  assert.equal(st.role, "player");
  assert.equal(st.members.length, 3);
  assert.equal(cs[0].state!.members.length, 3);
});

test("キック：ゲーム中にキックされた人は観戦で戻れる。元の席は自動のまま", () => {
  const { lobby, cs } = roomWith(3);
  send(lobby, cs[0], { t: "start" });
  const st0 = cs[0].state!;
  const victimId = st0.game!.seats.map((s) => s.id).find((id) => id !== st0.host)!;
  const victim = cs.find((c) => c.state!.you === victimId)!;
  const name = victim.state!.members.find((m) => m.id === victimId)!.name;
  send(lobby, cs[0], { t: "kick", id: victimId });
  assert.equal(victim.state, null);
  send(lobby, victim, { t: "join", key: "room", name });
  const st = victim.state!;
  assert.equal(st.role, "spectator");
  assert.notEqual(st.you, victimId, "新しいメンバーとして入る");
  assert.equal(st.game!.hand, null, "元の席の手札は見えない");
  const seat = st.game!.seats.find((s) => s.id === victimId)!;
  assert.equal(seat.gone, true, "元の席は自動のまま");
  send(lobby, victim, { t: "draw" });
  assert.match(victim.lastErr()!, /観戦中/);
  send(lobby, victim, { t: "queue", on: true });
  assert.equal(victim.state!.members.find((m) => m.id === st.you)!.queued, true, "次のゲームの参加予約はできる");
});

/** 手番の人が出したカードに別の人がドボン。ret を渡すと返し用の手札にする */
function forceDobon(lobby: Lobby, cs: FakeClient[], opts: { ret?: boolean } = {}) {
  const room = [...lobby.rooms.values()][0];
  const g = room.game!;
  g.pendingDraw = 0;
  const target = g.seats[g.turn];
  const card = { id: "t1", type: "NUM" as const, color: "Y" as const, value: 7 };
  g.discard.push(card);
  g.lastPlay = { by: target, cards: [card], points: 7, seq: g.lastPlay.seq + 1, cutin: false };
  g.windowOpen = true;
  g.noDobon = [];
  const dobonerId = g.seats.find((id) => id !== target)!;
  g.hands[dobonerId] = [
    { id: "x1", type: "NUM", color: "R", value: 3 },
    { id: "x2", type: "NUM", color: "B", value: 4 },
  ];
  if (opts.ret) g.hands[target] = [{ id: "x3", type: "NUM", color: "G", value: 7 }];
  const who = (id: string) => cs.find((c) => c.state?.you === id)!;
  send(lobby, who(dobonerId), { t: "dobon" });
  if (opts.ret) send(lobby, who(target), { t: "ret" });
  else {
    clock += 10_001;
    lobby.tick();
  }
  return { target, dobonerId };
}

test("ドボン返しの成績：返した人はドボン0、返された人は被ドボン1", () => {
  const { lobby, cs } = roomWith(3);
  send(lobby, cs[0], { t: "start" });
  const { target, dobonerId } = forceDobon(lobby, cs, { ret: true });
  const st = cs[0].state!;
  assert.equal(st.game!.result!.ret, target);
  assert.equal(st.games, 1);
  const row = (id: string) => st.stats.find((s) => s.id === id)!;
  assert.deepEqual([row(target).dobon, row(target).bedobon, row(target).total], [0, 0, 0]);
  assert.deepEqual([row(dobonerId).dobon, row(dobonerId).bedobon, row(dobonerId).total], [0, 1, 14]);
});

test("成績：同じ端末・同じ名前で入り直した人は1行にまとめる。名前を変えたら別の人", () => {
  const { lobby, cs } = roomWith(3);
  const name = (c: FakeClient) => c.state!.members.find((m) => m.id === c.state!.you)!.name;
  send(lobby, cs[0], { t: "start" });
  forceDobon(lobby, cs);
  send(lobby, cs[0], { t: "next" });
  assert.equal(cs[0].state!.stats.length, 3);
  // P1 は退室して同じ名前で戻る、P2 はキックされて別の名前で戻る
  const n1 = name(cs[1]);
  send(lobby, cs[1], { t: "leave" });
  send(lobby, cs[1], { t: "join", key: "room", name: n1 });
  send(lobby, cs[0], { t: "kick", id: cs[2].state!.you });
  send(lobby, cs[2], { t: "join", key: "room", name: "べつじん" });
  let stats = cs[0].state!.stats;
  assert.equal(stats.length, 3);
  const p1 = stats.find((s) => s.name === n1)!;
  assert.equal(p1.id, cs[1].state!.you, "今の自分の行として出る");
  assert.equal(p1.games, 1);
  assert.ok(!stats.some((s) => s.name === "べつじん"), "名前を変えたら前の成績は引き継がない");
  // もう1試合すると P1 は2試合になる
  send(lobby, cs[0], { t: "start" });
  forceDobon(lobby, cs);
  stats = cs[0].state!.stats;
  assert.equal(stats.find((s) => s.id === cs[1].state!.you)!.games, 2);
  assert.equal(stats.find((s) => s.name === "べつじん")!.games, 1);
  assert.equal(stats.length, 4);
});

test("入退室をくり返しても、成績に出てこない人の情報は残らない", () => {
  const { lobby, cs } = roomWith(2);
  const room = [...lobby.rooms.values()][0];
  const x = connect(lobby);
  for (let i = 0; i < 5; i++) {
    send(lobby, x, { t: "join", key: "room", name: `X${i}` });
    send(lobby, x, { t: "leave" });
  }
  assert.equal(room.names.size, 2);
  assert.equal(room.person.size, 0);
  assert.equal(room.back.size, 2);
  assert.equal(cs.length, 2);
});

test("キック：ゲーム中は席が残り、切断中と同じ扱い（10秒で自動処理）", () => {
  const { lobby, cs } = roomWith(3);
  send(lobby, cs[0], { t: "start" });
  const st = cs[0].state!;
  const seats = st.game!.seats.map((s) => s.id);
  const turnId = seats[st.game!.turn];
  const hostId = st.host;
  const victim = turnId !== hostId ? turnId : seats.find((id) => id !== hostId)!;
  send(lobby, cs[0], { t: "kick", id: victim });
  const g = cs[0].state!.game!;
  const seat = g.seats.find((s) => s.id === victim)!;
  assert.equal(seat.gone, true);
  assert.equal(g.seats.length, 3);
});

test("END GAMEはホストのみ・記録しない。NEXT ROUNDは確定後に参加者なら誰でも", () => {
  const { lobby, cs } = roomWith(2);
  send(lobby, cs[0], { t: "start" });
  send(lobby, cs[1], { t: "end" });
  assert.match(cs[1].lastErr()!, /ホスト/);
  send(lobby, cs[0], { t: "end" });
  assert.equal(cs[0].state!.phase, "LOBBY");
  assert.equal(cs[0].state!.games, 0);
});

test("ドボン→10秒後に確定→成績に記録→誰でもNEXT ROUND", () => {
  const { lobby, cs } = roomWith(3);
  send(lobby, cs[0], { t: "start" });
  const room = [...lobby.rooms.values()][0];
  const g = room.game!;
  // 直前に出されたカードの点数と同じ手札を持つ人を作ってドボンさせる
  const target = g.seats[g.turn];
  const card = g.hands[target].find((c) => c.type === "NUM" || true)!;
  g.lastPlay = { by: target, cards: [card], points: 7, seq: 2, cutin: false };
  g.windowOpen = true;
  const dobonerId = g.seats.find((id) => id !== target)!;
  g.hands[dobonerId] = [
    { id: "x1", type: "NUM", color: "R", value: 3 },
    { id: "x2", type: "NUM", color: "B", value: 4 },
  ];
  const doboner = cs.find((c) => c.state!.you === dobonerId)!;
  send(lobby, doboner, { t: "dobon" });
  assert.equal(doboner.state!.phase, "RESULT");
  send(lobby, doboner, { t: "next" });
  assert.match(doboner.lastErr()!, /確定/);
  clock += 10_001;
  lobby.tick();
  const r = doboner.state!.game!.result!;
  assert.equal(r.final, true);
  assert.equal(doboner.state!.games, 1);
  const stats = doboner.state!.stats;
  assert.equal(stats.find((s) => s.id === dobonerId)!.dobon, 1);
  assert.equal(stats.find((s) => s.id === target)!.bedobon, 1);
  assert.equal(stats.find((s) => s.id === target)!.total, handPoints(g.hands[target]) * 2);
  const other = cs.find((c) => c !== doboner)!;
  send(lobby, other, { t: "next" });
  assert.equal(other.state!.phase, "LOBBY");
});

test("観戦者の次ゲーム参加予約と、切断中の参加者の観戦への移動", () => {
  const { lobby, cs } = roomWith(2);
  const s = connect(lobby);
  send(lobby, s, { t: "join", key: "room", name: "S", spectate: true });
  send(lobby, s, { t: "queue", on: true });
  lobby.disconnect(cs[1]);
  send(lobby, cs[0], { t: "start" });
  const st = cs[0].state!;
  assert.equal(st.phase, "PLAYING");
  assert.equal(st.game!.seats.length, 2);
  assert.ok(st.game!.seats.some((x) => x.id === s.state!.you));
  const off = st.members.find((m) => m.name === "P1")!;
  assert.equal(off.role, "spectator");
  assert.equal(off.queued, true);
});

test("スタンプは1.5秒に1回まで", () => {
  const { lobby, cs } = roomWith(2);
  send(lobby, cs[0], { t: "stamp", s: 0 });
  send(lobby, cs[0], { t: "stamp", s: 1 });
  const stamps = cs[1].inbox.flatMap((m) => (m.t === "state" ? m.ev : [])).filter((e) => e.e === "stamp");
  assert.equal(stamps.length, 1);
});

test("送りすぎは捨てる（1秒10通・瞬間20通）", () => {
  const lobby = makeLobby();
  const c = new FakeClient();
  c.tokens = 20;
  c.tokensAt = clock;
  for (let i = 0; i < 50; i++) lobby.handle(c, JSON.stringify({ t: "ping", c: i }));
  assert.equal(c.inbox.filter((m) => m.t === "pong").length, 20);
});
