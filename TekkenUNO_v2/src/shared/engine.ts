// ゲーム進行の本体。サーバーだけが状態を持ち、画面はこの結果を表示するだけ。
// ルールの根拠は docs/RULES.md（章番号をコメントに書いている）。
import {
  type Card,
  type Color,
  canPlayFirst,
  cardPoints,
  handPoints,
  isColor,
  isValidStack,
  isWild,
  makeCardSet,
  sameCard,
} from "./cards.js";

export const HAND_SIZE = 7;
export const TURN_MS = 30_000; // 14章
export const OFFLINE_TURN_MS = 10_000; // 3章・14章
export const RESULT_WINDOW_MS = 10_000; // 11章
export const RECONNECT_MIN_MS = 5_000; // 14章
export const REFILL_COUNT = 2; // 8章

export type Mark = "DOBON" | "BEDOBON" | "NORMAL" | "DOBON_RETURN" | "BEDOBON_RETURN";

export interface ScoreRow {
  id: string;
  handPoints: number;
  finalScore: number;
  mark: Mark;
  /** ドボンに関係なく0点（12章） */
  zero: boolean;
  /** この試合で数えるドボン数・被ドボン数（13章：組ごと） */
  dobonCount: number;
  bedobonCount: number;
}

export interface LastPlay {
  /** 出した人。初期場札は null */
  by: string | null;
  cards: Card[];
  points: number;
  seq: number;
  cutin: boolean;
}

export interface ResultState {
  targetId: string | null;
  dobonBy: string[];
  returnBy: string | null;
  tablePoints: number;
  deadline: number;
  final: boolean;
  scores: ScoreRow[];
}

export interface GameState {
  gameNo: number;
  seats: string[];
  hands: Record<string, Card[]>;
  deck: Card[];
  discard: Card[];
  sets: number;
  turn: number;
  direction: 1 | -1;
  activeColor: Color | null;
  pendingDraw: number;
  drewThisTurn: boolean;
  turnStartedAt: number;
  turnDeadline: number;
  lastPlay: LastPlay;
  /** ドボン・カットインの受付中か（10章・7章） */
  windowOpen: boolean;
  /** 最後にカードが出てから引いた人（ドロー直後の禁止） */
  noDobon: string[];
  result: ResultState | null;
}

export type DrawReason = "normal" | "pending" | "timeout" | "refill" | "dobon";

export type GameEvent =
  | { e: "start"; first: string; card: Card }
  | { e: "play"; by: string; cards: Card[]; cutin: boolean; color: Color | null; pending: number }
  | { e: "draw"; by: string; n: number; why: DrawReason }
  | { e: "pass"; by: string; timeout: boolean }
  | { e: "uno"; by: string }
  | { e: "reshuffle"; added: boolean }
  | { e: "dobon"; by: string; target: string | null; pts: number; n: number }
  | { e: "ret"; by: string; targets: string[] }
  | { e: "final" };

export interface Ctx {
  now: number;
  rng: () => number;
  /** その人の手番の持ち時間（接続中30秒・切断中10秒） */
  timeoutFor: (playerId: string) => number;
}

export type Action =
  | { type: "play"; cardIds: string[]; color?: Color; cutin?: boolean }
  | { type: "draw" }
  | { type: "pass" }
  | { type: "dobon" }
  | { type: "dobonReturn" };

export type ActResult = { ok: true; events: GameEvent[] } | { ok: false; error: string };

// ---------------------------------------------------------------------------

function shuffle<T>(a: T[], rng: () => number): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function newSet(setNo: number, rng: () => number): Card[] {
  const cards = shuffle(makeCardSet(), rng);
  return cards.map((c, i) => ({ ...c, id: `${setNo}-${i}` }));
}

export function currentId(g: GameState): string {
  return g.seats[g.turn];
}

export function topCard(g: GameState): Card {
  return g.discard[g.discard.length - 1];
}

function advance(g: GameState, steps: number) {
  const n = g.seats.length;
  g.turn = (((g.turn + steps * g.direction) % n) + n) % n;
}

function startTurn(g: GameState, ctx: Ctx) {
  g.drewThisTurn = false;
  g.turnStartedAt = ctx.now;
  g.turnDeadline = ctx.now + ctx.timeoutFor(currentId(g));
}

/** 山札切れの処理（15章） */
function refillDeck(g: GameState, ctx: Ctx, events: GameEvent[]) {
  const keep = g.lastPlay.cards.length;
  const rest = g.discard.slice(0, Math.max(0, g.discard.length - keep));
  if (rest.length > 0) {
    g.discard = g.discard.slice(g.discard.length - keep);
    g.deck = shuffle(rest, ctx.rng);
    events.push({ e: "reshuffle", added: false });
    return;
  }
  g.sets += 1;
  g.deck = newSet(g.sets, ctx.rng);
  events.push({ e: "reshuffle", added: true });
}

function drawCards(g: GameState, playerId: string, n: number, ctx: Ctx, events: GameEvent[]) {
  const hand = g.hands[playerId];
  for (let i = 0; i < n; i++) {
    if (g.deck.length === 0) refillDeck(g, ctx, events);
    hand.push(g.deck.pop()!);
  }
}

function markDrew(g: GameState, playerId: string) {
  if (!g.noDobon.includes(playerId)) g.noDobon.push(playerId);
}

// ---------------------------------------------------------------------------
// ゲーム開始（4章）

export function createGame(playerIds: string[], gameNo: number, ctx: Ctx): { game: GameState; events: GameEvent[] } {
  if (playerIds.length < 2) throw new Error("参加者が2人以上必要です");
  const seats = shuffle(playerIds.slice(), ctx.rng);
  const deck = newSet(1, ctx.rng);
  const hands: Record<string, Card[]> = {};
  for (const id of seats) hands[id] = [];
  for (let r = 0; r < HAND_SIZE; r++) {
    for (const id of seats) hands[id].push(deck.pop()!);
  }
  const first = deck.pop()!;
  const g: GameState = {
    gameNo,
    seats,
    hands,
    deck,
    discard: [first],
    sets: 1,
    turn: Math.floor(ctx.rng() * seats.length),
    direction: 1,
    activeColor: isWild(first) ? null : first.color,
    pendingDraw: 0,
    drewThisTurn: false,
    turnStartedAt: ctx.now,
    turnDeadline: ctx.now,
    lastPlay: { by: null, cards: [first], points: cardPoints(first), seq: 1, cutin: false },
    windowOpen: true,
    noDobon: [],
    result: null,
  };
  const firstPlayer = currentId(g);
  // 初期場札の効果は最初の人が受ける
  if (first.type === "SKIP") advance(g, 1);
  if (first.type === "REVERSE") g.direction = -1;
  if (first.type === "DRAW2") g.pendingDraw = 2;
  if (first.type === "WILD4") g.pendingDraw = 4;
  startTurn(g, ctx);
  return { game: g, events: [{ e: "start", first: firstPlayer, card: first }] };
}

// ---------------------------------------------------------------------------
// 行動

export function act(g: GameState, playerId: string, action: Action, ctx: Ctx): ActResult {
  if (!g.seats.includes(playerId)) return fail("参加者ではありません");
  switch (action.type) {
    case "play":
      return play(g, playerId, action, ctx);
    case "draw":
      return draw(g, playerId, ctx);
    case "pass":
      return pass(g, playerId, ctx);
    case "dobon":
      return dobon(g, playerId, ctx);
    case "dobonReturn":
      return dobonReturn(g, playerId, ctx);
  }
}

function fail(error: string): ActResult {
  return { ok: false, error };
}

function pickCards(g: GameState, playerId: string, ids: unknown): Card[] | string {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 30) return "カードを選んでください";
  if (new Set(ids).size !== ids.length) return "同じカードが重複しています";
  const hand = g.hands[playerId];
  const out: Card[] = [];
  for (const id of ids) {
    const c = hand.find((x) => x.id === id);
    if (!c) return "手札にないカードです";
    out.push(c);
  }
  return out;
}

function play(g: GameState, by: string, a: Extract<Action, { type: "play" }>, ctx: Ctx): ActResult {
  if (g.result) return fail("ゲームは終了しています");
  const cards = pickCards(g, by, a.cardIds);
  if (typeof cards === "string") return fail(cards);
  const last = cards[cards.length - 1];
  const needColor = isWild(last);
  if (needColor && !isColor(a.color)) return fail("色を選んでください");

  // 手番の人が同じカードを出すのは普通の「出す」と同じ扱い
  const isTurn = currentId(g) === by;
  const cutin = !isTurn;
  if (cutin) {
    // 7章
    if (!g.windowOpen) return fail("カットインの受付は終わっています");
    const top = topCard(g);
    if (!cards.every((c) => sameCard(c, top))) return fail("カットインは場札と完全に同じカードだけです");
  } else {
    // 5章
    if (!canPlayFirst(topCard(g), g.activeColor, g.pendingDraw, cards[0])) {
      return fail(g.pendingDraw > 0 ? "累積中は返し札しか出せません" : "そのカードは出せません");
    }
    if (!isValidStack(cards)) return fail("重ね出しは同じ数字か同じ種類だけです");
  }

  const events: GameEvent[] = [];
  const hand = g.hands[by];
  const ids = new Set(cards.map((c) => c.id));
  g.hands[by] = hand.filter((c) => !ids.has(c.id));
  for (const c of cards) g.discard.push(c);

  g.lastPlay = {
    by,
    cards,
    points: cards.reduce((s, c) => s + cardPoints(c), 0),
    seq: g.lastPlay.seq + 1,
    cutin,
  };
  g.activeColor = needColor ? (a.color as Color) : last.color;
  g.windowOpen = true;
  g.noDobon = [];

  if (cutin) g.turn = g.seats.indexOf(by);

  // 6章
  const reverses = cards.filter((c) => c.type === "REVERSE").length;
  if (reverses % 2 === 1) g.direction = g.direction === 1 ? -1 : 1;
  const skips = cards.filter((c) => c.type === "SKIP").length;
  const steps = last.type === "SKIP" ? 2 * skips : 1;
  for (const c of cards) {
    if (c.type === "DRAW2") g.pendingDraw += 2;
    if (c.type === "WILD4") g.pendingDraw += 4;
  }

  events.push({
    e: "play",
    by,
    cards,
    cutin,
    color: needColor ? (a.color as Color) : null,
    pending: g.pendingDraw,
  });

  advance(g, steps);
  startTurn(g, ctx);

  // 8章・9章
  if (g.hands[by].length === 0) {
    drawCards(g, by, REFILL_COUNT, ctx, events);
    markDrew(g, by);
    events.push({ e: "draw", by, n: REFILL_COUNT, why: "refill" });
  } else if (g.hands[by].length === 1) {
    events.push({ e: "uno", by });
  }
  return { ok: true, events };
}

function draw(g: GameState, by: string, ctx: Ctx): ActResult {
  if (g.result) return fail("ゲームは終了しています");
  if (currentId(g) !== by) return fail("あなたの手番ではありません");
  const events: GameEvent[] = [];
  if (g.pendingDraw > 0) {
    const n = g.pendingDraw;
    drawCards(g, by, n, ctx, events);
    g.pendingDraw = 0;
    markDrew(g, by);
    g.windowOpen = false;
    events.push({ e: "draw", by, n, why: "pending" });
    advance(g, 1);
    startTurn(g, ctx);
    return { ok: true, events };
  }
  if (g.drewThisTurn) return fail("この手番ではもう引きました");
  drawCards(g, by, 1, ctx, events);
  g.drewThisTurn = true;
  markDrew(g, by);
  g.windowOpen = false;
  events.push({ e: "draw", by, n: 1, why: "normal" });
  return { ok: true, events };
}

function pass(g: GameState, by: string, ctx: Ctx): ActResult {
  if (g.result) return fail("ゲームは終了しています");
  if (currentId(g) !== by) return fail("あなたの手番ではありません");
  if (g.pendingDraw > 0) return fail("累積中はパスできません。返すか引いてください");
  if (!g.drewThisTurn) return fail("パスはドローした後だけできます");
  advance(g, 1);
  startTurn(g, ctx);
  return { ok: true, events: [{ e: "pass", by, timeout: false }] };
}

// ---------------------------------------------------------------------------
// ドボン（10章〜12章）

function dobon(g: GameState, by: string, ctx: Ctx): ActResult {
  const pts = handPoints(g.hands[by]);
  if (g.result) {
    // 追加ドボン（ダブロン・トリロン…）
    const r = g.result;
    if (r.final || ctx.now > r.deadline) return fail("追加ドボンの受付は終わっています");
    if (r.returnBy) return fail("ドボン返しの後は追加ドボンできません");
    if (r.dobonBy.includes(by)) return fail("すでにドボンしています");
    if (r.targetId === by) return fail("自分が出したカードにはドボンできません");
    if (g.noDobon.includes(by)) return fail("カードを引いた直後はドボンできません");
    if (pts !== r.tablePoints) return fail("ドボン不成立");
    r.dobonBy.push(by);
    r.scores = computeScores(g, r);
    return { ok: true, events: [{ e: "dobon", by, target: r.targetId, pts: r.tablePoints, n: r.dobonBy.length }] };
  }
  if (!g.windowOpen) return fail("ドボンの受付は終わっています");
  if (g.lastPlay.by === by) return fail("自分が出したカードにはドボンできません");
  if (g.noDobon.includes(by)) return fail("カードを引いた直後はドボンできません");
  if (pts !== g.lastPlay.points) return fail("ドボン不成立");

  const events: GameEvent[] = [];
  // ドロー札で累積が残っていれば、受けるはずだった人が先に引く（10章）
  if (g.pendingDraw > 0) {
    const receiver = currentId(g);
    const n = g.pendingDraw;
    drawCards(g, receiver, n, ctx, events);
    g.pendingDraw = 0;
    markDrew(g, receiver);
    events.push({ e: "draw", by: receiver, n, why: "dobon" });
  }
  g.windowOpen = false;
  const r: ResultState = {
    targetId: g.lastPlay.by,
    dobonBy: [by],
    returnBy: null,
    tablePoints: g.lastPlay.points,
    deadline: ctx.now + RESULT_WINDOW_MS,
    final: false,
    scores: [],
  };
  r.scores = computeScores(g, r);
  g.result = r;
  events.unshift({ e: "dobon", by, target: r.targetId, pts: r.tablePoints, n: 1 });
  return { ok: true, events };
}

function dobonReturn(g: GameState, by: string, ctx: Ctx): ActResult {
  const r = g.result;
  if (!r) return fail("ドボン返しは結果画面でだけできます");
  if (r.final || ctx.now > r.deadline) return fail("ドボン返しの受付は終わっています");
  if (r.returnBy) return fail("ドボン返しは済んでいます");
  if (r.targetId !== by) return fail("ドボン返しは被ドボン者だけができます");
  if (handPoints(g.hands[by]) !== r.tablePoints) return fail("ドボン返し不成立");
  r.returnBy = by;
  r.final = true;
  r.scores = computeScores(g, r);
  return { ok: true, events: [{ e: "ret", by, targets: r.dobonBy.slice() }, { e: "final" }] };
}

/** 12章・13章 */
export function computeScores(g: GameState, r: ResultState): ScoreRow[] {
  const n = r.dobonBy.length;
  return g.seats.map((id) => {
    const hp = handPoints(g.hands[id]);
    const row: ScoreRow = { id, handPoints: hp, finalScore: hp, mark: "NORMAL", zero: false, dobonCount: 0, bedobonCount: 0 };
    if (r.returnBy) {
      // ドボン返し：返した人はドボン数に数えない（0）。返された元のドボン者はそれぞれ被ドボン1
      if (id === r.returnBy) {
        row.mark = "DOBON_RETURN";
        row.finalScore = 0;
      } else if (r.dobonBy.includes(id)) {
        row.mark = "BEDOBON_RETURN";
        row.finalScore = hp * 2;
        row.bedobonCount = 1;
      }
    } else if (r.dobonBy.includes(id)) {
      row.mark = "DOBON";
      row.finalScore = 0;
      row.dobonCount = 1;
    } else if (id === r.targetId) {
      row.mark = "BEDOBON";
      row.finalScore = hp * 2 ** n;
      row.bedobonCount = n;
    }
    row.zero = row.mark === "NORMAL" && row.finalScore === 0;
    return row;
  });
}

// ---------------------------------------------------------------------------
// 時間の処理（11章・14章）

export function tick(g: GameState, ctx: Ctx): GameEvent[] {
  const events: GameEvent[] = [];
  if (g.result) {
    if (!g.result.final && ctx.now > g.result.deadline) {
      g.result.final = true;
      events.push({ e: "final" });
    }
    return events;
  }
  if (ctx.now < g.turnDeadline) return events;
  const id = currentId(g);
  if (g.pendingDraw > 0) {
    const n = g.pendingDraw;
    drawCards(g, id, n, ctx, events);
    g.pendingDraw = 0;
    markDrew(g, id);
    g.windowOpen = false;
    events.push({ e: "draw", by: id, n, why: "timeout" });
  } else {
    if (!g.drewThisTurn) {
      drawCards(g, id, 1, ctx, events);
      g.drewThisTurn = true;
      markDrew(g, id);
      g.windowOpen = false;
      events.push({ e: "draw", by: id, n: 1, why: "timeout" });
    }
    events.push({ e: "pass", by: id, timeout: true });
  }
  advance(g, 1);
  startTurn(g, ctx);
  return events;
}

/** 手番中の人の接続が切れた・戻ったときの持ち時間調整（14章） */
export function onConnectionChange(g: GameState, playerId: string, online: boolean, ctx: Ctx) {
  if (g.result || currentId(g) !== playerId) return;
  if (online) {
    g.turnDeadline = Math.max(g.turnDeadline, ctx.now + RECONNECT_MIN_MS);
  } else {
    g.turnDeadline = Math.min(g.turnDeadline, ctx.now + OFFLINE_TURN_MS);
  }
}

/** ドボンを押せる状態か（点数は見ない。画面のボタン表示用） */
export function dobonButtonOpen(g: GameState, playerId: string, now: number): boolean {
  if (!g.seats.includes(playerId)) return false;
  if (g.result) {
    const r = g.result;
    return (
      !r.final &&
      now <= r.deadline &&
      !r.returnBy &&
      !r.dobonBy.includes(playerId) &&
      r.targetId !== playerId &&
      !g.noDobon.includes(playerId)
    );
  }
  return g.windowOpen && g.lastPlay.by !== playerId && !g.noDobon.includes(playerId);
}
