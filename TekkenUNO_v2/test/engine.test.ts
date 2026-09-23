// docs/RULES.md の各章をそのまま確かめるテスト
import { test } from "node:test";
import assert from "node:assert/strict";
import { type Card, type CardType, type Color, canPlayFirst, handPoints } from "../src/shared/cards.js";
import {
  type Ctx,
  type GameState,
  act,
  computeScores,
  createGame,
  currentId,
  tick,
  onConnectionChange,
  dobonButtonOpen,
  OFFLINE_TURN_MS,
  RESULT_WINDOW_MS,
} from "../src/shared/engine.js";

// ---------- helpers ----------
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let now = 1_000_000;
const ctx = (over: Partial<Ctx> = {}): Ctx => ({ now, rng: mulberry32(7), timeoutFor: () => 30_000, ...over });

let nid = 0;
function C(type: CardType, color: Color | null, value?: number): Card {
  return { id: `t${nid++}`, type, color, value };
}
const N = (color: Color, v: number) => C("NUM", color, v);

/** P0..P{n-1} が席順どおり、P0 の手番、場札 top の状態を作る */
function setup(n: number, top: Card = N("R", 5)): GameState {
  const seats = Array.from({ length: n }, (_, i) => `P${i}`);
  const hands: Record<string, Card[]> = {};
  for (const id of seats) hands[id] = [N("G", 9), N("B", 8)];
  const deck = Array.from({ length: 40 }, (_, i) => N("Y", (i % 9) + 1));
  return {
    gameNo: 1,
    seats,
    hands,
    deck,
    discard: [top],
    sets: 1,
    turn: 0,
    direction: 1,
    activeColor: top.color,
    pendingDraw: 0,
    drewThisTurn: false,
    turnStartedAt: now,
    turnDeadline: now + 30_000,
    lastPlay: { by: null, cards: [top], points: 5, seq: 1, cutin: false },
    windowOpen: false,
    noDobon: [],
    result: null,
  };
}
function give(g: GameState, id: string, ...cards: Card[]) {
  g.hands[id] = cards;
  return cards;
}
function ok(r: ReturnType<typeof act>) {
  if (!r.ok) assert.fail(`expected ok, got: ${r.error}`);
  return r.events;
}
function ng(r: ReturnType<typeof act>, re?: RegExp) {
  assert.equal(r.ok, false, "expected failure");
  if (re && !r.ok) assert.match(r.error, re);
}
const playIds = (g: GameState, id: string, cards: Card[], color?: Color) =>
  act(g, id, { type: "play", cardIds: cards.map((c) => c.id), color }, ctx());

// ---------- 1章・5章 カードの基本 ----------
test("点数：数字=数、記号20、WILD30、WILD4 50", () => {
  assert.equal(handPoints([N("R", 7), C("SKIP", "B"), C("WILD", null), C("WILD4", null)]), 7 + 20 + 30 + 50);
});

test("出せる条件：色・数字・種類、WILDはいつでも、色指定なしは何でも", () => {
  const r7 = N("R", 7);
  assert.ok(canPlayFirst(r7, "R", 0, N("R", 3)));
  assert.ok(canPlayFirst(r7, "R", 0, N("B", 7)));
  assert.ok(!canPlayFirst(r7, "R", 0, N("B", 3)));
  assert.ok(canPlayFirst(C("SKIP", "R"), "R", 0, C("SKIP", "B")));
  assert.ok(!canPlayFirst(C("SKIP", "R"), "R", 0, C("REVERSE", "B")));
  assert.ok(canPlayFirst(r7, "R", 0, C("WILD4", null)));
  assert.ok(canPlayFirst(C("WILD", null), "G", 0, N("G", 1)));
  assert.ok(!canPlayFirst(C("WILD", null), "G", 0, N("R", 1)));
  assert.ok(canPlayFirst(C("WILD", null), null, 0, N("R", 1)), "色指定なしなら何でも");
  assert.ok(canPlayFirst(C("WILD4", null), null, 0, C("SKIP", "Y")), "色指定なしなら何でも");
});

test("返し札：DRAW2にはDRAW2かWILD4、WILD4にはWILD4だけ", () => {
  assert.ok(canPlayFirst(C("DRAW2", "R"), "R", 2, C("DRAW2", "B")));
  assert.ok(canPlayFirst(C("DRAW2", "R"), "R", 2, C("WILD4", null)));
  assert.ok(!canPlayFirst(C("DRAW2", "R"), "R", 2, N("R", 1)));
  assert.ok(canPlayFirst(C("WILD4", null), "B", 4, C("WILD4", null)));
  assert.ok(!canPlayFirst(C("WILD4", null), "B", 4, C("DRAW2", "B")));
});

// ---------- 4章 開始 ----------
test("開始：7枚ずつ・初期場札1枚・山札の残り", () => {
  const { game: g } = createGame(["a", "b", "c", "d"], 1, ctx({ rng: mulberry32(1) }));
  for (const id of g.seats) assert.equal(g.hands[id].length, 7);
  assert.equal(g.discard.length, 1);
  assert.equal(g.deck.length, 108 - 28 - 1);
  assert.deepEqual([...g.seats].sort(), ["a", "b", "c", "d"]);
  const ids = new Set([...g.deck, ...g.discard, ...Object.values(g.hands).flat()].map((c) => c.id));
  assert.equal(ids.size, 108, "カードidは重複しない");
});

test("カードidはゲームごとに別（同じidが前のゲームの別のカードを指さない）", () => {
  const all = (g: GameState) => [...g.deck, ...g.discard, ...Object.values(g.hands).flat()].map((c) => c.id);
  const g1 = createGame(["a", "b"], 1, ctx({ rng: mulberry32(11) })).game;
  const g2 = createGame(["a", "b"], 2, ctx({ rng: mulberry32(12) })).game;
  const ids1 = new Set(all(g1));
  assert.ok(!all(g2).some((id) => ids1.has(id)), "1試合目と2試合目でidが重ならない");
  // 配られる手札のidも重ならない（前はここが毎回同じ範囲になっていた）
  const hand1 = new Set(Object.values(g1.hands).flat().map((c) => c.id));
  assert.ok(!Object.values(g2.hands).flat().some((c) => hand1.has(c.id)));
});

function gameWithFirst(type: CardType) {
  for (let seed = 1; seed < 20000; seed++) {
    const rng = mulberry32(seed);
    const res = createGame(["a", "b", "c", "d"], 1, { now, rng, timeoutFor: () => 30_000 });
    if (res.game.discard[0].type === type) return res;
  }
  throw new Error("not found");
}

test("初期場札SKIP：最初の人を飛ばす", () => {
  const { game: g, events } = gameWithFirst("SKIP");
  const first = (events[0] as { first: string }).first;
  const fi = g.seats.indexOf(first);
  assert.equal(g.turn, (fi + 1) % 4);
});
test("初期場札REVERSE：向きだけ反転、最初の人はそのまま", () => {
  const { game: g, events } = gameWithFirst("REVERSE");
  assert.equal(g.direction, -1);
  assert.equal(currentId(g), (events[0] as { first: string }).first);
});
test("初期場札DRAW2：最初の人に累積2（返し可）", () => {
  const { game: g } = gameWithFirst("DRAW2");
  assert.equal(g.pendingDraw, 2);
});
test("初期場札WILD：色指定なし、最初の人は何でも出せる", () => {
  const { game: g } = gameWithFirst("WILD");
  assert.equal(g.activeColor, null);
  const id = currentId(g);
  const c = give(g, id, N("G", 3), N("B", 1))[0];
  ok(playIds(g, id, [c]));
});
test("初期場札WILD4：最初の人に累積4、引いた後の次の人は何でも出せる", () => {
  const { game: g } = gameWithFirst("WILD4");
  assert.equal(g.pendingDraw, 4);
  const id = currentId(g);
  give(g, id, N("G", 3));
  ok(act(g, id, { type: "draw" }, ctx()));
  assert.equal(g.hands[id].length, 5);
  const next = currentId(g);
  assert.notEqual(next, id);
  const c = give(g, next, N("Y", 2), N("B", 1))[0];
  ok(playIds(g, next, [c]));
});

// ---------- 5章 出す・重ね出し ----------
test("重ね出し：同じ数字の色違い、最後が場札、場札点は合計", () => {
  const g = setup(4);
  const cs = give(g, "P0", N("R", 7), N("B", 7), N("Y", 7), N("G", 1));
  ok(playIds(g, "P0", cs.slice(0, 3)));
  assert.equal(g.discard.at(-1)!.id, cs[2].id);
  assert.equal(g.activeColor, "Y");
  assert.equal(g.lastPlay.points, 21);
  assert.equal(currentId(g), "P1");
});
test("重ね出し：記号は同じ種類なら可、DRAW2とWILD4は混ぜられない", () => {
  const g = setup(4, C("DRAW2", "R"));
  const d2 = C("DRAW2", "R");
  const w4 = C("WILD4", null);
  give(g, "P0", d2, w4, N("G", 1));
  ng(playIds(g, "P0", [d2, w4], "B"), /重ね出し/);
  const g2 = setup(4);
  const s = give(g2, "P0", C("SKIP", "R"), C("REVERSE", "B"), N("G", 1));
  ng(playIds(g2, "P0", [s[0], s[1]]), /重ね出し/);
});
test("WILDは色の指定が必要。2枚重ねでも指定は最後の1回", () => {
  const g = setup(4);
  const w = give(g, "P0", C("WILD", null), C("WILD", null), N("G", 1));
  ng(playIds(g, "P0", [w[0]]), /色/);
  ok(playIds(g, "P0", [w[0], w[1]], "G"));
  assert.equal(g.activeColor, "G");
  assert.equal(g.lastPlay.points, 60);
});
test("同じカードidの重複は受け付けない（点数の水増し防止）", () => {
  const g = setup(4);
  const c = give(g, "P0", N("R", 7), N("G", 1))[0];
  ng(act(g, "P0", { type: "play", cardIds: [c.id, c.id] }, ctx()), /重複/);
});
test("手番でない人は（カットイン以外）出せない・出せないカードは出せない", () => {
  const g = setup(4);
  const c = give(g, "P1", N("R", 3), N("G", 1))[0];
  ng(playIds(g, "P1", [c]), /カットイン/);
  const bad = give(g, "P0", N("B", 3), N("G", 1))[0];
  ng(playIds(g, "P0", [bad]), /出せません/);
});

// ---------- 6章 効果 ----------
test("SKIP：k枚で2k席（4人で2枚なら自分、5人で2枚なら3人飛ばし）", () => {
  const cases: [number, number, string][] = [
    [4, 1, "P2"],
    [4, 2, "P0"],
    [5, 2, "P4"],
    [2, 1, "P0"],
  ];
  for (const [n, k, expected] of cases) {
    const g = setup(n, C("SKIP", "R"));
    const skips = (["R", "G", "B"] as Color[]).slice(0, k).map((col) => C("SKIP", col));
    give(g, "P0", ...skips, N("G", 1));
    ok(playIds(g, "P0", skips));
    assert.equal(currentId(g), expected, `${n}人でSKIP${k}枚`);
  }
});
test("REVERSE：奇数枚で反転、偶数枚でそのまま、2人戦は普通に相手の番", () => {
  const g = setup(4, C("REVERSE", "R"));
  const r = give(g, "P0", C("REVERSE", "R"), C("REVERSE", "B"), N("G", 1));
  ok(playIds(g, "P0", [r[0]]));
  assert.equal(g.direction, -1);
  assert.equal(currentId(g), "P3");
  const g2 = setup(4, C("REVERSE", "R"));
  const r2 = give(g2, "P0", C("REVERSE", "R"), C("REVERSE", "B"), N("G", 1));
  ok(playIds(g2, "P0", [r2[0], r2[1]]));
  assert.equal(g2.direction, 1);
  assert.equal(currentId(g2), "P1");
  const g3 = setup(2, C("REVERSE", "R"));
  const r3 = give(g3, "P0", C("REVERSE", "R"), N("G", 1));
  ok(playIds(g3, "P0", [r3[0]]));
  assert.equal(currentId(g3), "P1");
});
test("累積ドロー：加算・返し・まとめて引いて手番終了・累積中はパス不可", () => {
  const g = setup(4, C("DRAW2", "R"));
  const a = give(g, "P0", C("DRAW2", "R"), C("DRAW2", "B"), N("G", 1));
  ok(playIds(g, "P0", [a[0], a[1]]));
  assert.equal(g.pendingDraw, 4);
  const b = give(g, "P1", C("WILD4", null), N("G", 1));
  ng(act(g, "P1", { type: "pass" }, ctx()), /累積/);
  ng(playIds(g, "P1", [b[1]]), /返し札/);
  ok(playIds(g, "P1", [b[0]], "B"));
  assert.equal(g.pendingDraw, 8);
  give(g, "P2", C("DRAW2", "B"), N("G", 1));
  ng(playIds(g, "P2", [g.hands.P2[0]]), /返し札/);
  ok(act(g, "P2", { type: "draw" }, ctx()));
  assert.equal(g.hands.P2.length, 10);
  assert.equal(g.pendingDraw, 0);
  assert.equal(currentId(g), "P3");
});
test("通常ドロー：1手番1回、引いた後は何でも出せる（重ね出しも）、パスはドロー後だけ", () => {
  const g = setup(4);
  const cs = give(g, "P0", N("R", 3), N("B", 3), N("G", 1));
  ng(act(g, "P0", { type: "pass" }, ctx()), /ドローした後/);
  ok(act(g, "P0", { type: "draw" }, ctx()));
  ng(act(g, "P0", { type: "draw" }, ctx()), /もう引きました/);
  ok(playIds(g, "P0", [cs[0], cs[1]]));
  assert.equal(currentId(g), "P1");
  ok(act(g, "P1", { type: "draw" }, ctx()));
  ok(act(g, "P1", { type: "pass" }, ctx()));
  assert.equal(currentId(g), "P2");
});

// ---------- 8章・9章 ----------
test("手札0枚になったら2枚引いて手番終了、手札1枚でUNO", () => {
  const g = setup(4);
  const last = give(g, "P0", N("R", 7))[0];
  const ev = ok(playIds(g, "P0", [last]));
  assert.equal(g.hands.P0.length, 2);
  assert.ok(ev.some((e) => e.e === "draw" && e.why === "refill" && e.n === 2));
  assert.ok(g.noDobon.includes("P0"));
  assert.equal(currentId(g), "P1");
  const g2 = setup(4);
  const two = give(g2, "P0", N("R", 7), N("G", 1));
  const ev2 = ok(playIds(g2, "P0", [two[0]]));
  assert.ok(ev2.some((e) => e.e === "uno" && e.by === "P0"));
});

// ---------- 7章 カットイン ----------
test("カットイン：完全に同じカードだけ、カットインした人の次へ、自分へのカットインも可", () => {
  const g = setup(5);
  const a = give(g, "P0", N("R", 7), N("R", 7), N("G", 1));
  ok(playIds(g, "P0", [a[0]]));
  const b = give(g, "P3", N("B", 7), N("G", 2));
  ng(playIds(g, "P3", [b[0]]), /完全に同じ/);
  ok(playIds(g, "P0", [a[1]]));
  assert.equal(currentId(g), "P1", "自分へのカットイン後は自分の次");
  assert.equal(g.lastPlay.points, 7);
  const c = give(g, "P3", N("R", 7), N("G", 2));
  ok(playIds(g, "P3", [c[0]]));
  assert.equal(currentId(g), "P4", "間の人は飛ばされる");
  assert.equal(g.lastPlay.by, "P3");
});
test("カットイン受付は手番の人がドローするかカードを出すまで", () => {
  const g = setup(4);
  const a = give(g, "P0", N("R", 7), N("G", 1));
  ok(playIds(g, "P0", [a[0]]));
  const b = give(g, "P2", N("R", 7), N("G", 2));
  ok(act(g, "P1", { type: "draw" }, ctx()));
  ng(playIds(g, "P2", [b[0]]), /受付は終わって/);
});
test("無効な操作では受付は閉じない", () => {
  const g = setup(4);
  const a = give(g, "P0", N("R", 7), N("G", 1));
  ok(playIds(g, "P0", [a[0]]));
  ng(act(g, "P1", { type: "pass" }, ctx()));
  const bad = give(g, "P1", N("B", 3), N("G", 5))[0];
  ng(playIds(g, "P1", [bad]));
  const b = give(g, "P2", N("R", 7), N("G", 2));
  ok(playIds(g, "P2", [b[0]]));
});
test("カットイン：SKIPは2人目、DRAW2は累積に加算、WILD4は色を選び直し元の人に8枚が回ることもある", () => {
  const g = setup(5, C("SKIP", "R"));
  const s = give(g, "P0", C("SKIP", "R"), N("G", 1))[0];
  ok(playIds(g, "P0", [s]));
  const s2 = give(g, "P3", C("SKIP", "R"), N("G", 1))[0];
  ok(playIds(g, "P3", [s2]));
  assert.equal(currentId(g), "P0");

  const g2 = setup(4, C("DRAW2", "B"));
  const d = give(g2, "P0", C("DRAW2", "B"), N("G", 1))[0];
  ok(playIds(g2, "P0", [d]));
  const d2 = give(g2, "P2", C("DRAW2", "B"), N("G", 1))[0];
  ok(playIds(g2, "P2", [d2]));
  assert.equal(g2.pendingDraw, 4);
  assert.equal(currentId(g2), "P3");

  const g3 = setup(4);
  const w = give(g3, "P0", C("WILD4", null), N("G", 1))[0];
  ok(playIds(g3, "P0", [w], "B"));
  const w2 = give(g3, "P3", C("WILD4", null), N("G", 1))[0];
  ng(playIds(g3, "P3", [w2]), /色/);
  ok(playIds(g3, "P3", [w2], "Y"));
  assert.equal(g3.pendingDraw, 8);
  assert.equal(g3.activeColor, "Y");
  assert.equal(currentId(g3), "P0");
});
test("初期場札にもカットインできる", () => {
  const { game: g } = createGame(["a", "b", "c"], 1, ctx({ rng: mulberry32(3) }));
  const top = g.discard[0];
  const who = g.seats.find((id) => id !== currentId(g))!;
  const dup: Card = { ...top, id: "dup" };
  g.hands[who].push(dup);
  const r = act(g, who, { type: "play", cardIds: ["dup"], color: "R" }, ctx());
  ok(r);
  assert.equal(g.lastPlay.by, who);
});

// ---------- 10章 ドボン ----------
test("ドボン成立：場札点=手札点、被ドボン者は出した人、×2", () => {
  const g = setup(4);
  const a = give(g, "P0", N("R", 7), N("G", 3), N("B", 4));
  ok(playIds(g, "P0", [a[0]]));
  give(g, "P2", N("G", 2), N("B", 5));
  ok(act(g, "P2", { type: "dobon" }, ctx()));
  const r = g.result!;
  assert.equal(r.targetId, "P0");
  const row = (id: string) => r.scores.find((s) => s.id === id)!;
  assert.equal(row("P2").finalScore, 0);
  assert.equal(row("P0").finalScore, 14);
  assert.equal(row("P1").finalScore, handPoints(g.hands.P1));
});
test("ドボンを外しても何も起きない（他の人は続けてドボンできる）", () => {
  const g = setup(4);
  const a = give(g, "P0", N("R", 7), N("G", 1));
  ok(playIds(g, "P0", [a[0]]));
  give(g, "P3", N("G", 1));
  ng(act(g, "P3", { type: "dobon" }, ctx()), /不成立/);
  assert.equal(g.windowOpen, true);
  give(g, "P2", N("G", 2), N("B", 5));
  ok(act(g, "P2", { type: "dobon" }, ctx()));
});
test("自分が出したカードにはドボンできない、次の人がドローしたら受付終了", () => {
  const g = setup(4);
  const a = give(g, "P0", N("R", 3), N("G", 1), N("B", 3));
  ok(playIds(g, "P0", [a[0]]));
  ng(act(g, "P0", { type: "dobon" }, ctx()), /自分/);
  ok(act(g, "P1", { type: "draw" }, ctx()));
  give(g, "P2", N("G", 3));
  ng(act(g, "P2", { type: "dobon" }, ctx()), /受付は終わって/);
});
test("初期場札へのドボン：被ドボン者なし", () => {
  const g = setup(3);
  g.windowOpen = true;
  give(g, "P1", N("G", 2), N("B", 3));
  ok(act(g, "P1", { type: "dobon" }, ctx()));
  const r = g.result!;
  assert.equal(r.targetId, null);
  assert.ok(r.scores.every((s) => s.mark !== "BEDOBON"));
  assert.equal(r.scores.find((s) => s.id === "P1")!.finalScore, 0);
});
test("ドロー札へのドボン：受ける人が先に引き、その人は追加ドボンできない", () => {
  const g = setup(4, C("DRAW2", "R"));
  const d = give(g, "P0", C("DRAW2", "R"), N("G", 1))[0];
  ok(playIds(g, "P0", [d]));
  give(g, "P1", C("SKIP", "Y")); // 20点
  give(g, "P3", C("SKIP", "G")); // 20点
  g.deck.push(N("Y", 0), N("Y", 0)); // P1 が引く2枚は0点 → 引いた後も20点
  ok(act(g, "P3", { type: "dobon" }, ctx()));
  assert.equal(g.hands.P1.length, 3, "累積2枚を先に引く");
  assert.equal(handPoints(g.hands.P1), 20);
  assert.ok(g.noDobon.includes("P1"));
  ng(act(g, "P1", { type: "dobon" }, ctx()), /引いた直後/);
});
test("ダブロン：10秒以内の追加ドボンで×4、組ごとに数える。締切後は不可、tickで確定", () => {
  const g = setup(4);
  const a = give(g, "P0", N("R", 7), N("G", 3), N("B", 4));
  ok(playIds(g, "P0", [a[0]]));
  give(g, "P2", N("G", 2), N("B", 5));
  give(g, "P3", N("G", 6), N("B", 1));
  give(g, "P1", N("G", 7));
  ok(act(g, "P2", { type: "dobon" }, ctx()));
  ok(act(g, "P3", { type: "dobon" }, ctx({ now: now + 5000 })));
  const t = g.result!.scores.find((s) => s.id === "P0")!;
  assert.equal(t.finalScore, 7 * 4);
  assert.equal(t.bedobonCount, 2);
  ng(act(g, "P1", { type: "dobon" }, ctx({ now: now + RESULT_WINDOW_MS + 1 })), /受付は終わって/);
  const ev = tick(g, ctx({ now: now + RESULT_WINDOW_MS + 1 }));
  assert.ok(ev.some((e) => e.e === "final"));
  assert.equal(g.result!.final, true);
});
test("ドボン返し：被ドボン者だけ、成立で即確定、元のドボン者は各自×2、以降の追加ドボン不可", () => {
  const g = setup(4);
  const a = give(g, "P0", N("R", 7), N("G", 3), N("B", 4));
  ok(playIds(g, "P0", [a[0]]));
  give(g, "P2", N("G", 2), N("B", 5));
  give(g, "P3", N("G", 6), N("B", 1));
  give(g, "P1", N("G", 7));
  ok(act(g, "P2", { type: "dobon" }, ctx()));
  ok(act(g, "P3", { type: "dobon" }, ctx()));
  ng(act(g, "P2", { type: "dobonReturn" }, ctx()), /被ドボン者/);
  ok(act(g, "P0", { type: "dobonReturn" }, ctx()));
  const r = g.result!;
  assert.equal(r.final, true);
  const row = (id: string) => r.scores.find((s) => s.id === id)!;
  assert.equal(row("P0").finalScore, 0);
  assert.equal(row("P0").dobonCount, 0, "返した人はドボン数に数えない");
  assert.equal(row("P0").bedobonCount, 0);
  assert.equal(row("P2").finalScore, 14);
  assert.equal(row("P3").finalScore, 14);
  assert.equal(row("P2").bedobonCount, 1);
  assert.equal(row("P2").dobonCount, 0);
  assert.equal(row("P3").bedobonCount, 1);
  ng(act(g, "P1", { type: "dobon" }, ctx()));
});
test("最後の1枚を出した直後のドボン：2枚補充後の手札で計算、返しも補充後の手札で判定", () => {
  const g = setup(4);
  const last = give(g, "P0", N("R", 7))[0];
  g.deck.push(N("G", 3), N("B", 4));
  ok(playIds(g, "P0", [last]));
  give(g, "P2", N("G", 2), N("B", 5));
  ok(act(g, "P2", { type: "dobon" }, ctx()));
  assert.equal(g.result!.scores.find((s) => s.id === "P0")!.finalScore, 14);
  ok(act(g, "P0", { type: "dobonReturn" }, ctx()));
});
test("0点の印：ドボンに関係なく0点", () => {
  const g = setup(3);
  g.windowOpen = true;
  give(g, "P1", N("G", 2), N("B", 3));
  give(g, "P2", N("G", 0));
  ok(act(g, "P1", { type: "dobon" }, ctx()));
  assert.equal(g.result!.scores.find((s) => s.id === "P2")!.zero, true);
  assert.equal(g.result!.scores.find((s) => s.id === "P1")!.zero, false);
});
test("ドボンボタンの受付表示（点数は見ない）", () => {
  const g = setup(3);
  const a = give(g, "P0", N("R", 7), N("G", 1));
  ok(playIds(g, "P0", [a[0]]));
  assert.equal(dobonButtonOpen(g, "P0", now), false);
  assert.equal(dobonButtonOpen(g, "P2", now), true);
  ok(act(g, "P1", { type: "draw" }, ctx()));
  assert.equal(dobonButtonOpen(g, "P2", now), false);
});

// ---------- 14章 時間 ----------
test("時間切れ：未ドローなら1枚引いてパス（ドロー扱いで受付終了）", () => {
  const g = setup(4);
  const a = give(g, "P0", N("R", 7), N("G", 1));
  ok(playIds(g, "P0", [a[0]]));
  const ev = tick(g, ctx({ now: g.turnDeadline }));
  assert.ok(ev.some((e) => e.e === "draw" && e.why === "timeout"));
  assert.equal(g.hands.P1.length, 3);
  assert.equal(g.windowOpen, false);
  assert.ok(g.noDobon.includes("P1"));
  assert.equal(currentId(g), "P2");
});
test("時間切れ：累積中は全部引いて手番終了", () => {
  const g = setup(4, C("DRAW2", "R"));
  const d = give(g, "P0", C("DRAW2", "R"), N("G", 1))[0];
  ok(playIds(g, "P0", [d]));
  tick(g, ctx({ now: g.turnDeadline }));
  assert.equal(g.hands.P1.length, 4);
  assert.equal(currentId(g), "P2");
});
test("切断中の人の手番は10秒、再接続で最低5秒", () => {
  const g = setup(3);
  const a = give(g, "P0", N("R", 7), N("G", 1));
  ok(act(g, "P0", { type: "play", cardIds: [a[0].id] }, ctx({ timeoutFor: (id) => (id === "P1" ? OFFLINE_TURN_MS : 30_000) })));
  assert.equal(g.turnDeadline, now + OFFLINE_TURN_MS);
  onConnectionChange(g, "P1", true, ctx({ now: g.turnDeadline - 1000 }));
  assert.equal(g.turnDeadline, now + OFFLINE_TURN_MS - 1000 + 5000);
  onConnectionChange(g, "P1", false, ctx({ now: now + 1000 }));
  assert.equal(g.turnDeadline, now + 1000 + OFFLINE_TURN_MS);
});

// ---------- 15章 山札切れ ----------
test("山札切れ：場札以外を切り直し、それでも足りなければ1セット追加", () => {
  const g = setup(3);
  const a = give(g, "P0", N("R", 3), N("B", 3), N("G", 1));
  g.discard = [N("Y", 1), N("Y", 2), g.discard[0]];
  ok(playIds(g, "P0", [a[0], a[1]]));
  g.deck = [];
  ok(act(g, "P1", { type: "draw" }, ctx()));
  assert.deepEqual(
    g.discard.map((c) => c.id),
    [a[0].id, a[1].id],
    "直前の1回で出したカードは残す",
  );
  assert.equal(g.deck.length, 2);
  // 次に大量に引かせる
  g.pendingDraw = 8;
  g.turn = 2;
  ok(act(g, "P2", { type: "draw" }, ctx()));
  assert.equal(g.sets, 2);
  const all = [...g.deck, ...g.discard, ...Object.values(g.hands).flat()].map((c) => c.id);
  assert.equal(new Set(all).size, all.length, "追加セットでもidは重複しない");
});

test("computeScores：ドボン返しの成績は、返した人0・返された人はそれぞれ被ドボン1", () => {
  const g = setup(3);
  const r = { targetId: "P0", dobonBy: ["P1", "P2"], returnBy: "P0", tablePoints: 5, deadline: 0, final: true, scores: [] };
  const rows = computeScores(g, r);
  const row = (id: string) => rows.find((x) => x.id === id)!;
  assert.deepEqual([row("P0").dobonCount, row("P0").bedobonCount], [0, 0]);
  assert.deepEqual([row("P1").dobonCount, row("P1").bedobonCount], [0, 1]);
  assert.deepEqual([row("P2").dobonCount, row("P2").bedobonCount], [0, 1]);
});
