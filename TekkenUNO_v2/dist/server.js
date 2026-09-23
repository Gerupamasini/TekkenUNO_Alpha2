// src/server/app.ts
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants as zc, gzipSync } from "node:zlib";

// src/server/rooms.ts
import { randomBytes } from "node:crypto";

// src/shared/cards.ts
var COLORS = ["R", "G", "B", "Y"];
function isColor(x) {
  return x === "R" || x === "G" || x === "B" || x === "Y";
}
function isWild(c) {
  return c.type === "WILD" || c.type === "WILD4";
}
function makeCardSet() {
  const out = [];
  for (const color of COLORS) {
    out.push({ type: "NUM", color, value: 0 });
    for (let v = 1; v <= 9; v++) {
      out.push({ type: "NUM", color, value: v }, { type: "NUM", color, value: v });
    }
    for (const type of ["SKIP", "REVERSE", "DRAW2"]) {
      out.push({ type, color }, { type, color });
    }
  }
  for (let i = 0; i < 4; i++) out.push({ type: "WILD", color: null });
  for (let i = 0; i < 4; i++) out.push({ type: "WILD4", color: null });
  return out;
}
function cardPoints(c) {
  switch (c.type) {
    case "NUM":
      return c.value ?? 0;
    case "SKIP":
    case "REVERSE":
    case "DRAW2":
      return 20;
    case "WILD":
      return 30;
    case "WILD4":
      return 50;
  }
}
function handPoints(cards) {
  let s = 0;
  for (const c of cards) s += cardPoints(c);
  return s;
}
function sameCard(a, b) {
  return a.type === b.type && a.color === b.color && (a.value ?? -1) === (b.value ?? -1);
}
function sameValueOrEffect(a, b) {
  if (a.type === "NUM" && b.type === "NUM") return a.value === b.value;
  if (a.type !== "NUM" && b.type !== "NUM") return a.type === b.type;
  return false;
}
function canPlayFirst(top, activeColor, pendingDraw, c) {
  if (pendingDraw > 0) {
    if (top.type === "DRAW2") return c.type === "DRAW2" || c.type === "WILD4";
    if (top.type === "WILD4") return c.type === "WILD4";
    return false;
  }
  if (isWild(c)) return true;
  const topColor = isWild(top) ? activeColor : top.color;
  if (topColor === null) return true;
  if (c.color === topColor) return true;
  if (c.type === "NUM" && top.type === "NUM") return c.value === top.value;
  if (c.type !== "NUM" && top.type !== "NUM") return c.type === top.type;
  return false;
}
function isValidStack(cards) {
  if (cards.length === 0) return false;
  for (let i = 1; i < cards.length; i++) {
    if (!sameValueOrEffect(cards[i - 1], cards[i])) return false;
  }
  return true;
}
function cardLabel(c) {
  const col = c.color ? { R: "\u8D64", G: "\u7DD1", B: "\u9752", Y: "\u9EC4" }[c.color] : "";
  switch (c.type) {
    case "NUM":
      return `${col}${c.value}`;
    case "SKIP":
      return `${col}\u30B9\u30AD\u30C3\u30D7`;
    case "REVERSE":
      return `${col}\u30EA\u30D0\u30FC\u30B9`;
    case "DRAW2":
      return `${col}\u30C9\u30ED\u30FC2`;
    case "WILD":
      return "\u30EF\u30A4\u30EB\u30C9";
    case "WILD4":
      return "\u30C9\u30ED\u30FC4";
  }
}
function colorName(c) {
  if (!c) return "\u81EA\u7531";
  return { R: "\u8D64", G: "\u7DD1", B: "\u9752", Y: "\u9EC4" }[c];
}

// src/shared/engine.ts
var HAND_SIZE = 7;
var TURN_MS = 3e4;
var OFFLINE_TURN_MS = 1e4;
var RESULT_WINDOW_MS = 1e4;
var RECONNECT_MIN_MS = 5e3;
var REFILL_COUNT = 2;
function shuffle(a, rng) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function newSet(gameNo, setNo, rng) {
  const cards = shuffle(makeCardSet(), rng);
  return cards.map((c, i) => ({ ...c, id: `${gameNo}-${setNo}-${i}` }));
}
function currentId(g) {
  return g.seats[g.turn];
}
function topCard(g) {
  return g.discard[g.discard.length - 1];
}
function advance(g, steps) {
  const n = g.seats.length;
  g.turn = ((g.turn + steps * g.direction) % n + n) % n;
}
function startTurn(g, ctx) {
  g.drewThisTurn = false;
  g.turnStartedAt = ctx.now;
  g.turnDeadline = ctx.now + ctx.timeoutFor(currentId(g));
}
function refillDeck(g, ctx, events) {
  const keep = g.lastPlay.cards.length;
  const rest = g.discard.slice(0, Math.max(0, g.discard.length - keep));
  if (rest.length > 0) {
    g.discard = g.discard.slice(g.discard.length - keep);
    g.deck = shuffle(rest, ctx.rng);
    events.push({ e: "reshuffle", added: false });
    return;
  }
  g.sets += 1;
  g.deck = newSet(g.gameNo, g.sets, ctx.rng);
  events.push({ e: "reshuffle", added: true });
}
function drawCards(g, playerId, n, ctx, events) {
  const hand = g.hands[playerId];
  for (let i = 0; i < n; i++) {
    if (g.deck.length === 0) refillDeck(g, ctx, events);
    hand.push(g.deck.pop());
  }
}
function markDrew(g, playerId) {
  if (!g.noDobon.includes(playerId)) g.noDobon.push(playerId);
}
function createGame(playerIds, gameNo, ctx) {
  if (playerIds.length < 2) throw new Error("\u53C2\u52A0\u8005\u304C2\u4EBA\u4EE5\u4E0A\u5FC5\u8981\u3067\u3059");
  const seats = shuffle(playerIds.slice(), ctx.rng);
  const deck = newSet(gameNo, 1, ctx.rng);
  const hands = {};
  for (const id of seats) hands[id] = [];
  for (let r = 0; r < HAND_SIZE; r++) {
    for (const id of seats) hands[id].push(deck.pop());
  }
  const first = deck.pop();
  const g = {
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
    result: null
  };
  const firstPlayer = currentId(g);
  if (first.type === "SKIP") advance(g, 1);
  if (first.type === "REVERSE") g.direction = -1;
  if (first.type === "DRAW2") g.pendingDraw = 2;
  if (first.type === "WILD4") g.pendingDraw = 4;
  startTurn(g, ctx);
  return { game: g, events: [{ e: "start", first: firstPlayer, card: first }] };
}
function act(g, playerId, action, ctx) {
  if (!g.seats.includes(playerId)) return fail("\u53C2\u52A0\u8005\u3067\u306F\u3042\u308A\u307E\u305B\u3093");
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
function fail(error) {
  return { ok: false, error };
}
function pickCards(g, playerId, ids) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 30) return "\u30AB\u30FC\u30C9\u3092\u9078\u3093\u3067\u304F\u3060\u3055\u3044";
  if (new Set(ids).size !== ids.length) return "\u540C\u3058\u30AB\u30FC\u30C9\u304C\u91CD\u8907\u3057\u3066\u3044\u307E\u3059";
  const hand = g.hands[playerId];
  const out = [];
  for (const id of ids) {
    const c = hand.find((x) => x.id === id);
    if (!c) return "\u624B\u672D\u306B\u306A\u3044\u30AB\u30FC\u30C9\u3067\u3059";
    out.push(c);
  }
  return out;
}
function play(g, by, a, ctx) {
  if (g.result) return fail("\u30B2\u30FC\u30E0\u306F\u7D42\u4E86\u3057\u3066\u3044\u307E\u3059");
  const cards = pickCards(g, by, a.cardIds);
  if (typeof cards === "string") return fail(cards);
  const last = cards[cards.length - 1];
  const needColor = isWild(last);
  if (needColor && !isColor(a.color)) return fail("\u8272\u3092\u9078\u3093\u3067\u304F\u3060\u3055\u3044");
  const isTurn = currentId(g) === by;
  const cutin = !isTurn;
  if (cutin) {
    if (!g.windowOpen) return fail("\u30AB\u30C3\u30C8\u30A4\u30F3\u306E\u53D7\u4ED8\u306F\u7D42\u308F\u3063\u3066\u3044\u307E\u3059");
    const top = topCard(g);
    if (!cards.every((c) => sameCard(c, top))) return fail("\u30AB\u30C3\u30C8\u30A4\u30F3\u306F\u5834\u672D\u3068\u5B8C\u5168\u306B\u540C\u3058\u30AB\u30FC\u30C9\u3060\u3051\u3067\u3059");
  } else {
    if (!canPlayFirst(topCard(g), g.activeColor, g.pendingDraw, cards[0])) {
      return fail(g.pendingDraw > 0 ? "\u7D2F\u7A4D\u4E2D\u306F\u8FD4\u3057\u672D\u3057\u304B\u51FA\u305B\u307E\u305B\u3093" : "\u305D\u306E\u30AB\u30FC\u30C9\u306F\u51FA\u305B\u307E\u305B\u3093");
    }
    if (!isValidStack(cards)) return fail("\u91CD\u306D\u51FA\u3057\u306F\u540C\u3058\u6570\u5B57\u304B\u540C\u3058\u7A2E\u985E\u3060\u3051\u3067\u3059");
  }
  const events = [];
  const hand = g.hands[by];
  const ids = new Set(cards.map((c) => c.id));
  g.hands[by] = hand.filter((c) => !ids.has(c.id));
  for (const c of cards) g.discard.push(c);
  g.lastPlay = {
    by,
    cards,
    points: cards.reduce((s, c) => s + cardPoints(c), 0),
    seq: g.lastPlay.seq + 1,
    cutin
  };
  g.activeColor = needColor ? a.color : last.color;
  g.windowOpen = true;
  g.noDobon = [];
  if (cutin) g.turn = g.seats.indexOf(by);
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
    color: needColor ? a.color : null,
    pending: g.pendingDraw
  });
  advance(g, steps);
  startTurn(g, ctx);
  if (g.hands[by].length === 0) {
    drawCards(g, by, REFILL_COUNT, ctx, events);
    markDrew(g, by);
    events.push({ e: "draw", by, n: REFILL_COUNT, why: "refill" });
  } else if (g.hands[by].length === 1) {
    events.push({ e: "uno", by });
  }
  return { ok: true, events };
}
function draw(g, by, ctx) {
  if (g.result) return fail("\u30B2\u30FC\u30E0\u306F\u7D42\u4E86\u3057\u3066\u3044\u307E\u3059");
  if (currentId(g) !== by) return fail("\u3042\u306A\u305F\u306E\u624B\u756A\u3067\u306F\u3042\u308A\u307E\u305B\u3093");
  const events = [];
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
  if (g.drewThisTurn) return fail("\u3053\u306E\u624B\u756A\u3067\u306F\u3082\u3046\u5F15\u304D\u307E\u3057\u305F");
  drawCards(g, by, 1, ctx, events);
  g.drewThisTurn = true;
  markDrew(g, by);
  g.windowOpen = false;
  events.push({ e: "draw", by, n: 1, why: "normal" });
  return { ok: true, events };
}
function pass(g, by, ctx) {
  if (g.result) return fail("\u30B2\u30FC\u30E0\u306F\u7D42\u4E86\u3057\u3066\u3044\u307E\u3059");
  if (currentId(g) !== by) return fail("\u3042\u306A\u305F\u306E\u624B\u756A\u3067\u306F\u3042\u308A\u307E\u305B\u3093");
  if (g.pendingDraw > 0) return fail("\u7D2F\u7A4D\u4E2D\u306F\u30D1\u30B9\u3067\u304D\u307E\u305B\u3093\u3002\u8FD4\u3059\u304B\u5F15\u3044\u3066\u304F\u3060\u3055\u3044");
  if (!g.drewThisTurn) return fail("\u30D1\u30B9\u306F\u30C9\u30ED\u30FC\u3057\u305F\u5F8C\u3060\u3051\u3067\u304D\u307E\u3059");
  advance(g, 1);
  startTurn(g, ctx);
  return { ok: true, events: [{ e: "pass", by, timeout: false }] };
}
function dobon(g, by, ctx) {
  const pts = handPoints(g.hands[by]);
  if (g.result) {
    const r2 = g.result;
    if (r2.final || ctx.now > r2.deadline) return fail("\u8FFD\u52A0\u30C9\u30DC\u30F3\u306E\u53D7\u4ED8\u306F\u7D42\u308F\u3063\u3066\u3044\u307E\u3059");
    if (r2.returnBy) return fail("\u30C9\u30DC\u30F3\u8FD4\u3057\u306E\u5F8C\u306F\u8FFD\u52A0\u30C9\u30DC\u30F3\u3067\u304D\u307E\u305B\u3093");
    if (r2.dobonBy.includes(by)) return fail("\u3059\u3067\u306B\u30C9\u30DC\u30F3\u3057\u3066\u3044\u307E\u3059");
    if (r2.targetId === by) return fail("\u81EA\u5206\u304C\u51FA\u3057\u305F\u30AB\u30FC\u30C9\u306B\u306F\u30C9\u30DC\u30F3\u3067\u304D\u307E\u305B\u3093");
    if (g.noDobon.includes(by)) return fail("\u30AB\u30FC\u30C9\u3092\u5F15\u3044\u305F\u76F4\u5F8C\u306F\u30C9\u30DC\u30F3\u3067\u304D\u307E\u305B\u3093");
    if (pts !== r2.tablePoints) return fail("\u30C9\u30DC\u30F3\u4E0D\u6210\u7ACB");
    r2.dobonBy.push(by);
    r2.scores = computeScores(g, r2);
    return { ok: true, events: [{ e: "dobon", by, target: r2.targetId, pts: r2.tablePoints, n: r2.dobonBy.length }] };
  }
  if (!g.windowOpen) return fail("\u30C9\u30DC\u30F3\u306E\u53D7\u4ED8\u306F\u7D42\u308F\u3063\u3066\u3044\u307E\u3059");
  if (g.lastPlay.by === by) return fail("\u81EA\u5206\u304C\u51FA\u3057\u305F\u30AB\u30FC\u30C9\u306B\u306F\u30C9\u30DC\u30F3\u3067\u304D\u307E\u305B\u3093");
  if (g.noDobon.includes(by)) return fail("\u30AB\u30FC\u30C9\u3092\u5F15\u3044\u305F\u76F4\u5F8C\u306F\u30C9\u30DC\u30F3\u3067\u304D\u307E\u305B\u3093");
  if (pts !== g.lastPlay.points) return fail("\u30C9\u30DC\u30F3\u4E0D\u6210\u7ACB");
  const events = [];
  let drew = null;
  if (g.pendingDraw > 0) {
    const receiver = currentId(g);
    const n = g.pendingDraw;
    g.pendingDraw = 0;
    if (receiver !== by) {
      drawCards(g, receiver, n, ctx, events);
      markDrew(g, receiver);
      events.push({ e: "draw", by: receiver, n, why: "dobon" });
      drew = { id: receiver, n };
    }
  }
  g.windowOpen = false;
  const r = {
    targetId: g.lastPlay.by,
    dobonBy: [by],
    returnBy: null,
    drew,
    tablePoints: g.lastPlay.points,
    deadline: ctx.now + RESULT_WINDOW_MS,
    final: false,
    scores: []
  };
  r.scores = computeScores(g, r);
  g.result = r;
  events.unshift({ e: "dobon", by, target: r.targetId, pts: r.tablePoints, n: 1 });
  return { ok: true, events };
}
function dobonReturn(g, by, ctx) {
  const r = g.result;
  if (!r) return fail("\u30C9\u30DC\u30F3\u8FD4\u3057\u306F\u7D50\u679C\u753B\u9762\u3067\u3060\u3051\u3067\u304D\u307E\u3059");
  if (r.final || ctx.now > r.deadline) return fail("\u30C9\u30DC\u30F3\u8FD4\u3057\u306E\u53D7\u4ED8\u306F\u7D42\u308F\u3063\u3066\u3044\u307E\u3059");
  if (r.returnBy) return fail("\u30C9\u30DC\u30F3\u8FD4\u3057\u306F\u6E08\u3093\u3067\u3044\u307E\u3059");
  if (r.targetId !== by) return fail("\u30C9\u30DC\u30F3\u8FD4\u3057\u306F\u88AB\u30C9\u30DC\u30F3\u8005\u3060\u3051\u304C\u3067\u304D\u307E\u3059");
  if (handPoints(g.hands[by]) !== r.tablePoints) return fail("\u30C9\u30DC\u30F3\u8FD4\u3057\u4E0D\u6210\u7ACB");
  r.returnBy = by;
  r.final = true;
  r.scores = computeScores(g, r);
  return { ok: true, events: [{ e: "ret", by, targets: r.dobonBy.slice() }, { e: "final" }] };
}
function computeScores(g, r) {
  const n = r.dobonBy.length;
  return g.seats.map((id) => {
    const hp = handPoints(g.hands[id]);
    const row = { id, handPoints: hp, finalScore: hp, mark: "NORMAL", zero: false, dobonCount: 0, bedobonCount: 0 };
    if (r.returnBy) {
      if (id === r.returnBy) {
        row.mark = "DOBON_RETURN";
        row.finalScore = 0;
        row.dobonCount = 1;
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
function tick(g, ctx) {
  const events = [];
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
function onConnectionChange(g, playerId, online, ctx) {
  if (g.result || currentId(g) !== playerId) return;
  if (online) {
    g.turnDeadline = Math.max(g.turnDeadline, ctx.now + RECONNECT_MIN_MS);
  } else {
    g.turnDeadline = Math.min(g.turnDeadline, ctx.now + OFFLINE_TURN_MS);
  }
}
function dobonButtonOpen(g, playerId, now) {
  if (!g.seats.includes(playerId)) return false;
  if (g.result) {
    const r = g.result;
    return !r.final && now <= r.deadline && !r.returnBy && !r.dobonBy.includes(playerId) && r.targetId !== playerId && !g.noDobon.includes(playerId);
  }
  return g.windowOpen && g.lastPlay.by !== playerId && !g.noDobon.includes(playerId);
}

// src/shared/protocol.ts
var MAX_PLAYERS = 10;
var MAX_SPECTATORS = 20;
var NAME_MAX = 12;
var KEY_MAX = 32;
var STAMPS = ["\u30CA\u30A4\u30B9\uFF01", "\u3046\u305D\u3067\u3057\u3087", "\u3084\u3089\u308C\u305F\u2026", "\u30C9\u30DC\u30F3\u5F85\u3061", "\u306F\u3084\u304F\u301C", "\u3054\u3081\u3093", "www", "\u304A\u3064\u304B\u308C"];

// src/server/rooms.ts
var MAX_ROOMS = 200;
var HOST_OFFLINE_MS = 2e4;
var ROOM_EMPTY_MS = 10 * 6e4;
var STAMP_INTERVAL_MS = 1500;
var LOG_KEEP = 60;
function cryptoRng() {
  return randomBytes(4).readUInt32LE(0) / 4294967296;
}
function normalizeKey(raw) {
  if (typeof raw !== "string") return null;
  const k = raw.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  if (k.length === 0 || [...k].length > KEY_MAX) return null;
  return k;
}
var CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069\\ufeff]", "g");
function cleanName(raw) {
  const s = typeof raw === "string" ? raw : "";
  const t = s.replace(CONTROL_CHARS, "").replace(/\s+/g, " ").trim();
  const chars = [...t].slice(0, NAME_MAX).join("");
  return chars || "\u540D\u7121\u3057";
}
function baseName(name) {
  return name.replace(/\(\d+\)$/, "");
}
var TOKEN_RE = /^[0-9a-f]{32}$/;
var Lobby = class {
  rooms = /* @__PURE__ */ new Map();
  tokenIndex = /* @__PURE__ */ new Map();
  now;
  rng;
  build;
  constructor(opts = {}) {
    this.now = opts.now ?? Date.now;
    this.rng = opts.rng ?? cryptoRng;
    this.build = opts.build ?? "dev";
  }
  // ------------------------------------------------------------------ 接続
  disconnect(client) {
    const found = this.findByClient(client);
    if (!found) return;
    const { room, member } = found;
    member.clients.delete(client);
    if (member.clients.size === 0) this.setOnline(room, member, false);
  }
  handle(client, raw) {
    const t = this.now();
    client.tokens = Math.min(20, client.tokens + (t - client.tokensAt) / 1e3 * 10);
    client.tokensAt = t;
    if (client.tokens < 1) return;
    client.tokens -= 1;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object" || typeof msg.t !== "string") return;
    if (msg.t === "ping") {
      client.send({ t: "pong", c: Number(msg.c) || 0, s: t });
      return;
    }
    if (msg.t === "hello") return this.hello(client, msg);
    if (!client.token) return this.err(client, "\u63A5\u7D9A\u306E\u6E96\u5099\u304C\u3067\u304D\u3066\u3044\u307E\u305B\u3093\u3002\u518D\u8AAD\u307F\u8FBC\u307F\u3057\u3066\u304F\u3060\u3055\u3044");
    if (msg.t === "join") return this.join(client, msg);
    const found = this.findByToken(client.token);
    if (!found) {
      client.send({ t: "out", why: "left" });
      return;
    }
    const { room, member } = found;
    switch (msg.t) {
      case "leave":
        return this.leave(client, room, member);
      case "name":
        return this.rename(room, member, msg.name);
      case "role":
        return this.setRole(client, room, member, !!msg.spectate);
      case "queue":
        return this.setQueue(client, room, member, !!msg.on);
      case "start":
        return this.start(client, room, member);
      case "end":
        return this.end(client, room, member);
      case "next":
        return this.next(client, room, member);
      case "kick":
        return this.kick(client, room, member, String(msg.id));
      case "play":
        return this.gameAction(client, room, member, {
          type: "play",
          cardIds: Array.isArray(msg.ids) ? msg.ids.map(String) : [],
          color: msg.color
        });
      case "draw":
        return this.gameAction(client, room, member, { type: "draw" });
      case "pass":
        return this.gameAction(client, room, member, { type: "pass" });
      case "dobon":
        return this.gameAction(client, room, member, { type: "dobon" });
      case "ret":
        return this.gameAction(client, room, member, { type: "dobonReturn" });
      case "stamp":
        return this.stamp(room, member, Number(msg.s));
    }
  }
  err(client, m) {
    client.send({ t: "err", m });
  }
  hello(client, msg) {
    if (typeof msg.token !== "string" || !TOKEN_RE.test(msg.token)) return this.err(client, "\u4E0D\u6B63\u306A\u63A5\u7D9A\u3067\u3059");
    if (client.token && client.token !== msg.token) this.disconnect(client);
    client.token = msg.token;
    const found = this.findByToken(msg.token);
    client.send({ t: "hello", you: found?.member.id ?? null, now: this.now(), build: this.build });
    if (found) this.attach(client, found.room, found.member);
  }
  attach(client, room, member) {
    member.clients.add(client);
    if (member.clients.size === 1) this.setOnline(room, member, true);
    const s = this.view(room, member, this.stats(room));
    s.matches = this.matches(room);
    member.histSent = room.histRev;
    client.send({ t: "state", s, ev: [] });
  }
  setOnline(room, member, online) {
    const t = this.now();
    member.offlineSince = online ? null : t;
    if (online) room.emptySince = null;
    else if (![...room.members.values()].some((m) => m.clients.size > 0)) room.emptySince ??= t;
    const g = room.game;
    if (g && room.phase === "PLAYING" && g.seats.includes(member.id)) {
      onConnectionChange(g, member.id, online, this.ctx(room));
    }
    room.dirty = true;
  }
  // ------------------------------------------------------------------ 入退室
  join(client, msg) {
    const token = client.token;
    const key = normalizeKey(msg.key);
    if (!key) return this.err(client, `\u5408\u8A00\u8449\u306F1\u301C${KEY_MAX}\u6587\u5B57\u3067\u5165\u529B\u3057\u3066\u304F\u3060\u3055\u3044`);
    const current = this.findByToken(token);
    if (current) {
      if (current.room.key === key) return this.attach(client, current.room, current.member);
      if (!this.canLeave(current.room, current.member)) return this.err(client, "\u30B2\u30FC\u30E0\u4E2D\u306F\u5225\u306E\u90E8\u5C4B\u306B\u79FB\u308C\u307E\u305B\u3093");
      this.removeMember(current.room, current.member, "left");
    }
    let room = this.rooms.get(key);
    if (!room) {
      if (this.rooms.size >= MAX_ROOMS) return this.err(client, "\u90E8\u5C4B\u304C\u591A\u3059\u304E\u307E\u3059\u3002\u3057\u3070\u3089\u304F\u3057\u3066\u304B\u3089\u8A66\u3057\u3066\u304F\u3060\u3055\u3044");
      room = this.createRoom(key, String(msg.key).normalize("NFKC").trim());
    }
    const members = [...room.members.values()];
    const players = members.filter((m) => m.role === "player").length;
    const spectators = members.length - players;
    let role = msg.spectate || room.phase !== "LOBBY" ? "spectator" : "player";
    let queued = false;
    if (role === "player" && players >= MAX_PLAYERS) {
      role = "spectator";
      queued = true;
    }
    if (role === "spectator" && spectators >= MAX_SPECTATORS) return this.err(client, "\u3053\u306E\u90E8\u5C4B\u306F\u6E80\u54E1\u3067\u3059");
    const t = this.now();
    const name = cleanName(msg.name);
    const member = {
      id: randomBytes(5).toString("hex"),
      token,
      name: this.uniqueName(room, name, null),
      role,
      queued,
      queuedAt: t,
      joinedAt: t,
      clients: /* @__PURE__ */ new Set(),
      offlineSince: null,
      lastStamp: 0,
      histSent: -1
    };
    room.members.set(member.id, member);
    room.names.set(member.id, member.name);
    const prev = room.back.get(token);
    const person = prev && baseName(prev.name) === baseName(name) ? prev.person : member.id;
    if (person !== member.id) room.person.set(member.id, person);
    room.back.set(token, { person, name: member.name });
    this.tokenIndex.set(token, { key: room.key, memberId: member.id });
    room.histRev++;
    if (!room.hostId || !room.members.has(room.hostId)) room.hostId = member.id;
    room.emptySince = null;
    this.addLog(room, `${member.name}\u304C\u5165\u5BA4\u3057\u307E\u3057\u305F${role === "spectator" ? "\uFF08\u89B3\u6226\uFF09" : ""}`);
    room.dirty = true;
    client.send({ t: "hello", you: member.id, now: t, build: this.build });
    this.attach(client, room, member);
  }
  createRoom(key, display) {
    const room = {
      key,
      display: [...display].slice(0, KEY_MAX).join(""),
      hostId: "",
      members: /* @__PURE__ */ new Map(),
      names: /* @__PURE__ */ new Map(),
      person: /* @__PURE__ */ new Map(),
      back: /* @__PURE__ */ new Map(),
      phase: "LOBBY",
      game: null,
      recorded: false,
      history: [],
      log: [],
      events: [],
      dirty: true,
      emptySince: null,
      gameCount: 0,
      histRev: 0
    };
    this.rooms.set(key, room);
    return room;
  }
  uniqueName(room, base, selfId) {
    const taken = new Set([...room.members.values()].filter((m) => m.id !== selfId).map((m) => m.name));
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) {
      const suffix = `(${i})`;
      const cand = [...base].slice(0, NAME_MAX - suffix.length).join("") + suffix;
      if (!taken.has(cand)) return cand;
    }
  }
  canLeave(room, member) {
    return !(room.phase === "PLAYING" && room.game?.seats.includes(member.id));
  }
  leave(client, room, member) {
    if (!this.canLeave(room, member)) return this.err(client, "\u30B2\u30FC\u30E0\u4E2D\u306F\u9000\u5BA4\u3067\u304D\u307E\u305B\u3093");
    this.removeMember(room, member, "left");
  }
  removeMember(room, member, why) {
    room.members.delete(member.id);
    room.histRev++;
    this.tokenIndex.delete(member.token);
    for (const c of member.clients) c.send({ t: "out", why });
    member.clients.clear();
    this.addLog(room, why === "kicked" ? `${member.name}\u304C\u30AD\u30C3\u30AF\u3055\u308C\u307E\u3057\u305F` : `${member.name}\u304C\u9000\u5BA4\u3057\u307E\u3057\u305F`);
    const g = room.game;
    const seatedNow = !!g && g.seats.includes(member.id);
    if (g && room.phase === "PLAYING" && seatedNow) {
      onConnectionChange(g, member.id, false, this.ctx(room));
    }
    if (!seatedNow) this.forget(room, member);
    if (room.hostId === member.id) this.transferHost(room, true);
    if (room.members.size === 0) this.deleteRoom(room);
    else room.dirty = true;
  }
  /** 成績にも席にも出てこない人の情報を消す（入退室をくり返しても部屋の中身が増え続けないように） */
  forget(room, member) {
    const person = this.personOf(room, member.id);
    const rows = room.history.flatMap((rec) => rec.rows);
    if (!rows.some((r) => r.id === member.id)) {
      room.names.delete(member.id);
      room.person.delete(member.id);
    }
    const seated = room.game?.seats.some((id) => this.personOf(room, id) === person) ?? false;
    const recorded = rows.some((r) => this.personOf(room, r.id) === person);
    if (!seated && !recorded && room.back.get(member.token)?.person === person) room.back.delete(member.token);
  }
  deleteRoom(room) {
    for (const m of room.members.values()) this.tokenIndex.delete(m.token);
    this.rooms.delete(room.key);
  }
  rename(room, member, raw) {
    const name = this.uniqueName(room, cleanName(raw), member.id);
    if (name === member.name) return;
    this.addLog(room, `${member.name}\u304C\u540D\u524D\u3092${name}\u306B\u5909\u3048\u307E\u3057\u305F`);
    member.name = name;
    room.names.set(member.id, name);
    room.histRev++;
    const b = room.back.get(member.token);
    if (b) b.name = name;
    room.dirty = true;
  }
  setRole(client, room, member, spectate) {
    if (room.phase !== "LOBBY") return this.err(client, "\u30ED\u30D3\u30FC\u3067\u3060\u3051\u5909\u66F4\u3067\u304D\u307E\u3059");
    if (spectate) {
      member.role = "spectator";
      member.queued = false;
    } else {
      const players = [...room.members.values()].filter((m) => m.role === "player").length;
      if (member.role !== "player" && players >= MAX_PLAYERS) return this.err(client, "\u53C2\u52A0\u8005\u306F10\u4EBA\u307E\u3067\u3067\u3059");
      member.role = "player";
      member.queued = false;
    }
    room.dirty = true;
  }
  setQueue(client, room, member, on) {
    if (member.role !== "spectator") return this.err(client, "\u89B3\u6226\u8005\u3060\u3051\u304C\u4E88\u7D04\u3067\u304D\u307E\u3059");
    member.queued = on;
    member.queuedAt = this.now();
    room.dirty = true;
  }
  isHost(room, member) {
    return room.hostId === member.id;
  }
  /**
   * ホストの移譲。force はホストが部屋からいなくなったとき。
   * 切断が20秒続いたときは、接続中の人がいる場合だけ移す（全員切断中なら今のまま）
   */
  transferHost(room, force) {
    const cur = room.members.get(room.hostId);
    if (!force && cur && (cur.clients.size > 0 || this.now() - (cur.offlineSince ?? 0) < HOST_OFFLINE_MS)) return;
    const others = [...room.members.values()].filter((m) => m.id !== room.hostId);
    const online = others.filter((m) => m.clients.size > 0);
    const pool = online.length ? online : force ? others : [];
    pool.sort((a, b) => a.role === b.role ? a.joinedAt - b.joinedAt : a.role === "player" ? -1 : 1);
    const next = pool[0];
    if (!next) return;
    room.hostId = next.id;
    this.addLog(room, `\u30DB\u30B9\u30C8\u304C${next.name}\u306B\u79FB\u308A\u307E\u3057\u305F`);
    room.dirty = true;
  }
  kick(client, room, member, targetId) {
    if (!this.isHost(room, member)) return this.err(client, "\u30AD\u30C3\u30AF\u306F\u30DB\u30B9\u30C8\u3060\u3051\u304C\u3067\u304D\u307E\u3059");
    const target = room.members.get(targetId);
    if (!target) return;
    if (target.id === member.id) return this.err(client, "\u81EA\u5206\u306F\u30AD\u30C3\u30AF\u3067\u304D\u307E\u305B\u3093");
    this.removeMember(room, target, "kicked");
  }
  // ------------------------------------------------------------------ ゲームの開始・終了
  ctx(room) {
    return {
      now: this.now(),
      rng: this.rng,
      timeoutFor: (id) => {
        const m = room.members.get(id);
        return m && m.clients.size > 0 ? TURN_MS : OFFLINE_TURN_MS;
      }
    };
  }
  start(client, room, member) {
    if (!this.isHost(room, member)) return this.err(client, "START\u306F\u30DB\u30B9\u30C8\u3060\u3051\u304C\u3067\u304D\u307E\u3059");
    if (room.phase !== "LOBBY") return;
    const members = [...room.members.values()];
    for (const m of members) {
      if (m.role === "player" && m.clients.size === 0) {
        m.role = "spectator";
        m.queued = true;
        m.queuedAt = this.now();
      }
    }
    let players = members.filter((m) => m.role === "player").length;
    const queued = members.filter((m) => m.role === "spectator" && m.queued && m.clients.size > 0).sort((a, b) => a.queuedAt - b.queuedAt);
    for (const m of queued) {
      if (players >= MAX_PLAYERS) break;
      m.role = "player";
      m.queued = false;
      players++;
    }
    const ids = members.filter((m) => m.role === "player").sort((a, b) => a.joinedAt - b.joinedAt).map((m) => m.id);
    if (ids.length < 2) {
      room.dirty = true;
      return this.err(client, "\u53C2\u52A0\u8005\u304C2\u4EBA\u4EE5\u4E0A\u5FC5\u8981\u3067\u3059");
    }
    for (const id of ids) room.names.set(id, room.members.get(id).name);
    const { game, events } = createGame(ids, room.gameCount + 1, this.ctx(room));
    room.gameCount += 1;
    room.game = game;
    room.phase = "PLAYING";
    room.recorded = false;
    this.pushEvents(room, events);
  }
  end(client, room, member) {
    if (!this.isHost(room, member)) return this.err(client, "END GAME\u306F\u30DB\u30B9\u30C8\u3060\u3051\u304C\u3067\u304D\u307E\u3059");
    if (room.phase !== "PLAYING") return;
    this.toLobby(room);
    this.addLog(room, "\u30DB\u30B9\u30C8\u304C\u30B2\u30FC\u30E0\u3092\u4E2D\u65AD\u3057\u307E\u3057\u305F\uFF08\u8A18\u9332\u306A\u3057\uFF09");
  }
  next(client, room, member) {
    const g = room.game;
    if (room.phase !== "RESULT" || !g?.result) return;
    if (!g.result.final) return this.err(client, "\u7D50\u679C\u306E\u78BA\u5B9A\u3092\u5F85\u3063\u3066\u304F\u3060\u3055\u3044");
    if (!g.seats.includes(member.id) && !this.isHost(room, member)) return this.err(client, "\u53C2\u52A0\u8005\u3060\u3051\u304C\u6B21\u3078\u9032\u3081\u307E\u3059");
    this.toLobby(room);
  }
  toLobby(room) {
    room.phase = "LOBBY";
    room.game = null;
    room.dirty = true;
  }
  // ------------------------------------------------------------------ ゲーム中の操作
  gameAction(client, room, member, action) {
    const g = room.game;
    if (!g || room.phase === "LOBBY") return this.err(client, "\u30B2\u30FC\u30E0\u4E2D\u3067\u306F\u3042\u308A\u307E\u305B\u3093");
    if (!g.seats.includes(member.id)) return this.err(client, "\u89B3\u6226\u4E2D\u306F\u64CD\u4F5C\u3067\u304D\u307E\u305B\u3093");
    const r = act(g, member.id, action, this.ctx(room));
    if (!r.ok) return this.err(client, r.error);
    this.pushEvents(room, r.events);
  }
  stamp(room, member, s) {
    if (!Number.isInteger(s) || s < 0 || s >= STAMPS.length) return;
    const t = this.now();
    if (t - member.lastStamp < STAMP_INTERVAL_MS) return;
    member.lastStamp = t;
    room.events.push({ e: "stamp", by: member.id, s });
    room.dirty = true;
  }
  pushEvents(room, events) {
    for (const ev of events) {
      room.events.push(ev);
      const line = this.describe(room, ev);
      if (line) this.addLog(room, line);
    }
    const g = room.game;
    if (g?.result && room.phase === "PLAYING") room.phase = "RESULT";
    if (g?.result?.final && !room.recorded) this.record(room);
    room.dirty = true;
  }
  record(room) {
    const g = room.game;
    const r = g.result;
    room.recorded = true;
    room.history.push({
      no: g.gameNo,
      at: this.now(),
      pts: r.tablePoints,
      target: r.targetId,
      by: r.dobonBy.slice(),
      ret: r.returnBy,
      rows: r.scores.map((s) => ({
        id: s.id,
        hand: s.handPoints,
        score: s.finalScore,
        mark: s.mark,
        zero: s.zero,
        drew: r.drew?.id === s.id ? r.drew.n : 0,
        dobon: s.dobonCount,
        bedobon: s.bedobonCount
      }))
    });
    room.histRev++;
  }
  // ------------------------------------------------------------------ 時間の処理
  tick() {
    const t = this.now();
    for (const room of [...this.rooms.values()]) {
      const g = room.game;
      if (g && room.phase !== "LOBBY") {
        const events = tick(g, this.ctx(room));
        if (events.length) this.pushEvents(room, events);
      }
      this.transferHost(room, !room.members.has(room.hostId));
      const anyOnline = [...room.members.values()].some((m) => m.clients.size > 0);
      if (anyOnline) room.emptySince = null;
      else {
        room.emptySince ??= t;
        if (t - room.emptySince > ROOM_EMPTY_MS) {
          this.deleteRoom(room);
          continue;
        }
      }
      if (room.dirty) this.flush(room);
    }
  }
  /** 状態が変わった部屋に、各メンバー向けの表示データを送る */
  flushAll() {
    for (const room of this.rooms.values()) if (room.dirty) this.flush(room);
  }
  flush(room) {
    const stats = this.stats(room);
    const ev = room.events;
    room.events = [];
    room.dirty = false;
    let matches = null;
    for (const m of room.members.values()) {
      if (m.clients.size === 0) continue;
      const s = this.view(room, m, stats);
      if (m.histSent !== room.histRev) {
        matches ??= this.matches(room);
        s.matches = matches;
        m.histSent = room.histRev;
      }
      const msg = { t: "state", s, ev };
      for (const c of m.clients) c.send(msg);
    }
  }
  // ------------------------------------------------------------------ 表示データ
  nameOf(room, id) {
    if (!id) return "";
    return room.members.get(id)?.name ?? room.names.get(id) ?? "?";
  }
  view(room, m, stats) {
    const members = [...room.members.values()].sort((a, b) => a.joinedAt - b.joinedAt).map((x) => ({ id: x.id, name: x.name, role: x.role, online: x.clients.size > 0, queued: x.queued }));
    return {
      key: room.display,
      phase: room.phase,
      host: room.hostId,
      you: m.id,
      role: m.role,
      members,
      game: room.game ? this.gameView(room, room.game, m) : null,
      stats,
      games: room.history.length,
      log: room.log.slice(-30)
    };
  }
  gameView(room, g, m) {
    const top = topCard(g);
    const seated = g.seats.includes(m.id);
    const r = g.result;
    return {
      no: g.gameNo,
      seats: g.seats.map((id) => {
        const mem = room.members.get(id);
        return { id, name: this.nameOf(room, id), count: g.hands[id].length, online: !!mem && mem.clients.size > 0, gone: !mem };
      }),
      turn: g.turn,
      dir: g.direction,
      stack: g.lastPlay.cards,
      lastBy: g.lastPlay.by,
      cutin: g.lastPlay.cutin,
      tablePts: g.lastPlay.points,
      color: isWild(top) ? g.activeColor : top.color,
      pending: g.pendingDraw,
      drew: g.drewThisTurn,
      started: g.turnStartedAt,
      deadline: g.turnDeadline,
      window: g.windowOpen,
      canDobon: seated && dobonButtonOpen(g, m.id, this.now()),
      deck: g.deck.length,
      hand: seated ? g.hands[m.id] : null,
      result: r ? {
        target: r.targetId,
        by: r.dobonBy,
        ret: r.returnBy,
        pts: r.tablePoints,
        deadline: r.deadline,
        final: r.final,
        rows: r.scores.map((s) => ({
          id: s.id,
          name: this.nameOf(room, s.id),
          hand: s.handPoints,
          score: s.finalScore,
          mark: s.mark,
          zero: s.zero,
          drew: r.drew?.id === s.id ? r.drew.n : 0
        }))
      } : null
    };
  }
  personOf(room, id) {
    return room.person.get(id) ?? id;
  }
  /** 人（入り直しても同じ）→ 今いるメンバーの id */
  currentIds(room) {
    const out = /* @__PURE__ */ new Map();
    for (const m of room.members.values()) out.set(this.personOf(room, m.id), m.id);
    return out;
  }
  /** 試合別の成績（新しい順）。今いる人は今の id と名前で出す */
  matches(room) {
    const cur = this.currentIds(room);
    const idOf = (id) => cur.get(this.personOf(room, id)) ?? id;
    const opt = (id) => id ? idOf(id) : null;
    return room.history.map((rec) => ({
      no: rec.no,
      at: rec.at,
      pts: rec.pts,
      target: opt(rec.target),
      by: rec.by.map(idOf),
      ret: opt(rec.ret),
      rows: rec.rows.map((x) => {
        const id = idOf(x.id);
        return { id, name: this.nameOf(room, id), hand: x.hand, score: x.score, mark: x.mark, zero: x.zero, drew: x.drew };
      })
    })).reverse();
  }
  /** 成績。入り直した人（同じ端末・同じ名前）は1行にまとめ、いまの名前で出す */
  stats(room) {
    const acc = /* @__PURE__ */ new Map();
    for (const rec of room.history) {
      for (const r of rec.rows) {
        const p = this.personOf(room, r.id);
        let s = acc.get(p);
        if (!s) {
          s = { id: r.id, name: "", games: 0, total: 0, max: 0, dobon: 0, bedobon: 0 };
          acc.set(p, s);
        }
        s.id = r.id;
        s.games += 1;
        s.total += r.score;
        s.max = Math.max(s.max, r.score);
        s.dobon += r.dobon;
        s.bedobon += r.bedobon;
      }
    }
    for (const m of room.members.values()) {
      const s = acc.get(this.personOf(room, m.id));
      if (s) s.id = m.id;
    }
    for (const s of acc.values()) s.name = this.nameOf(room, s.id);
    return [...acc.values()].sort((a, b) => a.total / a.games - b.total / b.games);
  }
  addLog(room, m) {
    room.log.push({ t: this.now(), m });
    if (room.log.length > LOG_KEEP) room.log.splice(0, room.log.length - LOG_KEEP);
  }
  describe(room, ev) {
    const n = (id) => this.nameOf(room, id);
    switch (ev.e) {
      case "start":
        return `\u30B2\u30FC\u30E0${room.game?.gameNo ?? ""}\u958B\u59CB\u3002\u521D\u671F\u5834\u672D\u306F${cardLabel(ev.card)}\uFF08\u6700\u521D\u306F${n(ev.first)}\uFF09`;
      case "play":
        return `${ev.cutin ? "\u3010\u30AB\u30C3\u30C8\u30A4\u30F3\u3011" : ""}${n(ev.by)}\u304C${ev.cards.map(cardLabel).join("\u30FB")}\u3092\u51FA\u3057\u305F${ev.color ? `\uFF08${colorName(ev.color)}\uFF09` : ""}`;
      case "draw":
        switch (ev.why) {
          case "normal":
            return `${n(ev.by)}\u304C1\u679A\u5F15\u3044\u305F`;
          case "pending":
            return `${n(ev.by)}\u304C\u7D2F\u7A4D${ev.n}\u679A\u3092\u5F15\u3044\u305F`;
          case "timeout":
            return `${n(ev.by)}\u304C\u6642\u9593\u5207\u308C\u3067${ev.n}\u679A\u5F15\u3044\u305F`;
          case "refill":
            return `${n(ev.by)}\u306F\u624B\u672D0\u679A\u306B\u306A\u308A${ev.n}\u679A\u88DC\u5145`;
          case "dobon":
            return `${n(ev.by)}\u304C\u7D2F\u7A4D${ev.n}\u679A\u3092\u5F15\u3044\u305F\uFF08\u30C9\u30DC\u30F3\u6210\u7ACB\u306E\u305F\u3081\uFF09`;
        }
        return null;
      case "pass":
        return ev.timeout ? `${n(ev.by)}\u304C\u6642\u9593\u5207\u308C\u3067\u30D1\u30B9` : `${n(ev.by)}\u304C\u30D1\u30B9`;
      case "uno":
        return `${n(ev.by)}\uFF1AUNO!`;
      case "reshuffle":
        return ev.added ? "\u5C71\u672D\u304C\u5C3D\u304D\u305F\u306E\u3067\u65B0\u3057\u3044108\u679A\u3092\u8FFD\u52A0" : "\u6368\u3066\u672D\u3092\u5207\u308A\u76F4\u3057\u3066\u5C71\u672D\u306B\u623B\u3057\u305F";
      case "dobon":
        if (ev.n === 1) return `${n(ev.by)}\u304C\u30C9\u30DC\u30F3\uFF01${ev.target ? `\uFF08${n(ev.target)}\u3078\uFF09` : "\uFF08\u521D\u671F\u5834\u672D\uFF09"}`;
        return `${n(ev.by)}\u3082\u8FFD\u52A0\u30C9\u30DC\u30F3\uFF01\uFF08${ev.n}\u4EBA\uFF09`;
      case "ret":
        return `${n(ev.by)}\u304C\u30C9\u30DC\u30F3\u8FD4\u3057\uFF01`;
      case "final":
        return "\u7D50\u679C\u78BA\u5B9A";
      case "sys":
        return ev.m;
      case "stamp":
        return null;
    }
  }
  // ------------------------------------------------------------------ 検索
  findByToken(token) {
    const idx = this.tokenIndex.get(token);
    if (!idx) return null;
    const room = this.rooms.get(idx.key);
    const member = room?.members.get(idx.memberId);
    if (!room || !member) {
      this.tokenIndex.delete(token);
      return null;
    }
    return { room, member };
  }
  findByClient(client) {
    if (!client.token) return null;
    const f = this.findByToken(client.token);
    if (!f || !f.member.clients.has(client)) return null;
    return f;
  }
};

// src/server/ws.ts
import { createHash } from "node:crypto";
var GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
var MAX_MESSAGE = 16 * 1024;
var MAX_BUFFERED = 2 * 1024 * 1024;
var WsConn = class {
  constructor(socket, remote) {
    this.socket = socket;
    this.remote = remote;
    socket.on("data", (d) => this.feed(d));
    socket.on("close", () => this.finish());
    socket.on("end", () => this.finish());
    socket.on("error", () => this.finish());
  }
  socket;
  remote;
  buf = Buffer.alloc(0);
  fragments = [];
  fragOpcode = 0;
  fragSize = 0;
  closed = false;
  lastSeen = Date.now();
  handlers = { onMessage: () => {
  }, onClose: () => {
  } };
  send(text) {
    this.sendFrame(1, Buffer.from(text, "utf8"));
  }
  ping() {
    this.sendFrame(9, Buffer.alloc(0));
  }
  close(code = 1e3) {
    if (this.closed) return;
    const p = Buffer.alloc(2);
    p.writeUInt16BE(code, 0);
    this.sendFrame(8, p);
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 2e3).unref();
    this.finish();
  }
  terminate() {
    this.socket.destroy();
    this.finish();
  }
  /** 受信データを溜めてフレームに分解する */
  feed(chunk) {
    if (this.closed) return;
    this.lastSeen = Date.now();
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (; ; ) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 128) !== 0;
      const opcode = b0 & 15;
      const masked = (b1 & 128) !== 0;
      let len = b1 & 127;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        if (this.buf.readUInt32BE(2) !== 0) return this.close(1009);
        len = this.buf.readUInt32BE(6);
        off = 10;
      }
      if (len > MAX_MESSAGE) return this.close(1009);
      if (!masked) return this.close(1002);
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.allocUnsafe(len);
      const src = this.buf.subarray(off + 4, off + 4 + len);
      for (let i = 0; i < len; i++) payload[i] = src[i] ^ mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      this.onFrame(fin, opcode, payload);
      if (this.closed) return;
    }
  }
  onFrame(fin, opcode, payload) {
    switch (opcode) {
      case 0: {
        if (!this.fragOpcode) return this.close(1002);
        this.fragSize += payload.length;
        if (this.fragSize > MAX_MESSAGE) return this.close(1009);
        this.fragments.push(payload);
        if (fin) {
          const whole = Buffer.concat(this.fragments);
          const op = this.fragOpcode;
          this.fragments = [];
          this.fragOpcode = 0;
          this.fragSize = 0;
          if (op === 1) this.handlers.onMessage(whole.toString("utf8"));
        }
        return;
      }
      case 1:
      case 2:
        if (this.fragOpcode) return this.close(1002);
        if (!fin) {
          this.fragOpcode = opcode;
          this.fragments = [payload];
          this.fragSize = payload.length;
          return;
        }
        if (opcode === 1) this.handlers.onMessage(payload.toString("utf8"));
        return;
      case 8:
        this.sendFrame(8, payload.subarray(0, 2));
        this.socket.end();
        this.finish();
        return;
      case 9:
        this.sendFrame(10, payload);
        return;
      case 10:
        return;
      default:
        this.close(1002);
    }
  }
  sendFrame(opcode, payload) {
    if (this.closed || this.socket.destroyed) return;
    if (this.socket.writableLength > MAX_BUFFERED) {
      this.terminate();
      return;
    }
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([128 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 128 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 128 | opcode;
      header[1] = 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(len, 6);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }
  finish() {
    if (this.closed) return;
    this.closed = true;
    this.handlers.onClose();
  }
};
function acceptUpgrade(req, socket, head) {
  const key = req.headers["sec-websocket-key"];
  const upgrade = String(req.headers.upgrade ?? "").toLowerCase();
  if (upgrade !== "websocket" || typeof key !== "string" || req.headers["sec-websocket-version"] !== "13") {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return null;
  }
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r
Upgrade: websocket\r
Connection: Upgrade\r
Sec-WebSocket-Accept: ${accept}\r
\r
`
  );
  const s = socket;
  s.setNoDelay?.(true);
  const fwd = req.headers["x-forwarded-for"];
  const remote = (typeof fwd === "string" ? fwd.split(",")[0].trim() : "") || req.socket.remoteAddress || "?";
  const conn = new WsConn(socket, remote);
  if (head.length) queueMicrotask(() => conn.feed(head));
  return conn;
}

// src/server/app.ts
var BUILD = true ? "20260923165137" : "dev";
var VERSION = true ? "2.2.0" : "dev";
var here = path.dirname(fileURLToPath(import.meta.url));
var DEFAULT_CLIENT_DIR = existsSync(path.join(here, "client")) ? path.join(here, "client") : path.resolve(here, "../../dist/client");
var TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8"
};
var COMPRESSIBLE = /* @__PURE__ */ new Set([".html", ".js", ".css", ".svg", ".json", ".webmanifest", ".txt"]);
var CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
function fileLoader(clientDir) {
  const cache = /* @__PURE__ */ new Map();
  const useCache = BUILD !== "dev";
  return async (rel) => {
    if (cache.has(rel)) return cache.get(rel);
    const abs = path.resolve(clientDir, "." + rel);
    if (!abs.startsWith(clientDir + path.sep)) return null;
    let raw;
    try {
      raw = await readFile(abs);
    } catch {
      if (useCache) cache.set(rel, null);
      return null;
    }
    const ext = path.extname(abs).toLowerCase();
    const f = {
      type: TYPES[ext] ?? "application/octet-stream",
      raw,
      etag: `"${BUILD}-${raw.length}-${rel.length}"`,
      immutable: useCache && rel.startsWith("/assets/")
    };
    if (COMPRESSIBLE.has(ext) && raw.length > 512) {
      f.br = brotliCompressSync(raw, { params: { [zc.BROTLI_PARAM_QUALITY]: 11 } });
      f.gz = gzipSync(raw, { level: 9 });
    }
    if (useCache) cache.set(rel, f);
    return f;
  };
}
function startServer(opts) {
  const getFile = fileLoader(opts.clientDir ?? DEFAULT_CLIENT_DIR);
  const lobby = opts.lobby ?? new Lobby({ build: BUILD });
  const conns = /* @__PURE__ */ new Set();
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/healthz") {
        res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
        res.end("ok");
        return;
      }
      if (url.pathname === "/version") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ version: VERSION, build: BUILD }));
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405);
        res.end();
        return;
      }
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith("/")) rel += "index.html";
      let file = await getFile(rel);
      if (!file && !rel.startsWith("/assets/")) file = await getFile("/index.html");
      if (!file) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      const headers = {
        "content-type": file.type,
        "cache-control": file.immutable ? "public, max-age=31536000, immutable" : "no-cache",
        etag: file.etag,
        vary: "accept-encoding",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer"
      };
      if (file.type.startsWith("text/html")) headers["content-security-policy"] = CSP;
      if (req.headers["if-none-match"] === file.etag) {
        res.writeHead(304, headers);
        res.end();
        return;
      }
      const ae = String(req.headers["accept-encoding"] ?? "");
      let body = file.raw;
      if (file.br && /\bbr\b/.test(ae)) {
        body = file.br;
        headers["content-encoding"] = "br";
      } else if (file.gz && /\bgzip\b/.test(ae)) {
        body = file.gz;
        headers["content-encoding"] = "gzip";
      }
      headers["content-length"] = String(body.length);
      res.writeHead(200, headers);
      res.end(req.method === "HEAD" ? void 0 : body);
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const conn = acceptUpgrade(req, socket, head);
    if (!conn) return;
    conns.add(conn);
    const client = {
      token: null,
      tokens: 20,
      tokensAt: Date.now(),
      send: (msg) => conn.send(JSON.stringify(msg))
    };
    conn.handlers = {
      onMessage: (text) => {
        lobby.handle(client, text);
        lobby.flushAll();
      },
      onClose: () => {
        conns.delete(conn);
        lobby.disconnect(client);
        lobby.flushAll();
      }
    };
  });
  const heartbeat = setInterval(() => {
    const t = Date.now();
    for (const c of conns) {
      if (c.closed) conns.delete(c);
      else if (t - c.lastSeen > 45e3) c.terminate();
      else c.ping();
    }
  }, 15e3);
  heartbeat.unref();
  const ticker = setInterval(() => lobby.tick(), 200);
  const ready = new Promise((resolve) => {
    server.listen(opts.port, "0.0.0.0", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : opts.port);
    });
  });
  function close() {
    clearInterval(heartbeat);
    clearInterval(ticker);
    for (const c of conns) c.close(1001);
    return new Promise((resolve) => server.close(() => resolve()));
  }
  return { server, lobby, ready, close };
}

// src/server/index.ts
var app = startServer({ port: Number(process.env.PORT ?? 1e4), clientDir: process.env.CLIENT_DIR });
app.ready.then((port) => {
  console.log(`\u9244\u7814UNO server v${VERSION} (build ${BUILD}) listening on :${port}`);
});
function shutdown() {
  app.close().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 3e3).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
