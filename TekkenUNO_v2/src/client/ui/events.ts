// サーバーから届いた出来事（出した・引いた・ドボン…）を演出に変える
import { colorName } from "../../shared/cards.js";
import { type EventView, type RoomView, STAMPS } from "../../shared/protocol.js";
import * as fx from "../fx.js";
import { nameOf } from "../store.js";
import { DOBON_LABELS, where } from "./game.js";

export interface Pre {
  seats: Map<string, DOMRect>;
  cards: Map<string, DOMRect>;
  deck: DOMRect | null;
}

/** 描き直す前の位置を覚えておく（出したカードは手札から消えるため） */
export function capture(ev: EventView[], you: string | null): Pre {
  const pre: Pre = { seats: new Map(), cards: new Map(), deck: where.deck() };
  for (const e of ev) {
    if (e.e !== "play") continue;
    if (e.by === you) {
      for (const c of e.cards) {
        const r = where.handCard(c.id);
        if (r) pre.cards.set(c.id, r);
      }
    }
    const s = where.seat(e.by);
    if (s) pre.seats.set(e.by, s);
  }
  return pre;
}

function later(ms: number, fn: () => void) {
  if (ms <= 0) fn();
  else setTimeout(fn, ms);
}

/** 新しく来たカードを、飛んでくる演出が終わるまで隠す */
function hideUntil(container: Element | null, ids: string[], ms: number) {
  if (!container) return;
  ids.forEach((id, i) => {
    const el = container.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!el) return;
    el.classList.add("incoming");
    setTimeout(() => {
      el.classList.remove("incoming");
      fx.pop(el, "landed");
    }, ms + i * 60);
  });
}

export function playEvents(pre: Pre, ev: EventView[], prev: RoomView | null, cur: RoomView) {
  const you = cur.you;
  let t = 0;
  // 吹き出しは席（自分の席も含む）の上に出す。自分の席が無い観戦者のときは手札の位置
  const seatOrHand = (id: string) => where.seat(id) ?? where.hand();
  const flightTarget = (id: string) => (id === you ? where.hand() : where.seat(id));
  for (const e of ev) {
    switch (e.e) {
      case "start": {
        fx.banner("GAME START", "start", `ゲーム${cur.game?.no ?? ""}`, 1100);
        const deck = where.deck();
        if (deck && cur.game) {
          cur.game.seats.forEach((s, i) => {
            const to = s.id === you ? where.hand() : where.seat(s.id);
            if (to) void fx.flyCards(deck, to, [null, null, null], { delay: 200 + i * 70, stagger: 90, endScale: s.id === you ? 1 : 0.4, fadeOut: s.id !== you });
          });
          const hand = document.querySelector(".hand");
          const ids = cur.game.hand?.map((c) => c.id) ?? [];
          hideUntil(hand, ids, 650);
        }
        t += 300;
        break;
      }
      case "play": {
        const to = where.discard();
        const start = t;
        if (to) {
          e.cards.forEach((c, i) => {
            const from = pre.cards.get(c.id) ?? pre.seats.get(e.by) ?? where.seat(e.by) ?? pre.deck;
            if (from) later(start, () => void fx.flyCards(from, to, [c], { delay: i * 70, duration: 360, rotate: (i - e.cards.length / 2) * 5 }));
          });
          hideUntil(where.fan(), e.cards.map((c) => c.id), start + 340);
        }
        const last = e.cards[e.cards.length - 1];
        later(start + 300, () => {
          if (e.cutin) fx.banner("CUT IN!", "cutin", nameOf(e.by), 1100);
          if (e.cards.length >= 2) fx.bubble(to, `${e.cards.length}枚重ね！`, "stack");
          if (last.type === "SKIP") fx.bubble(to, e.cards.length > 1 ? `スキップ×${e.cards.length}` : "スキップ！", "skip");
          if (last.type === "REVERSE") {
            fx.pop(where.dir(), "spin");
            fx.bubble(to, e.cards.length % 2 ? "リバース！" : "リバース×2（そのまま）", "skip");
          }
          if ((last.type === "DRAW2" || last.type === "WILD4") && e.pending > 0) {
            fx.pop(where.pending(), "boom");
            if (e.pending >= 8) fx.shake(false);
          }
          if (e.color) fx.bubble(to, `${colorName(e.color)}！`, `color-${e.color}`, 1200);
        });
        t += 160 + e.cards.length * 60;
        break;
      }
      case "draw": {
        const target = flightTarget(e.by);
        const bubbleAt = seatOrHand(e.by);
        const deck = where.deck() ?? pre.deck;
        const n = Math.min(e.n, 8);
        const start = t;
        if (deck && target) {
          later(start, () =>
            void fx.flyCards(deck, target, Array(n).fill(null), { stagger: 55, duration: 360, endScale: e.by === you ? 1 : 0.4, fadeOut: e.by !== you }),
          );
        }
        if (e.by === you && prev?.game?.hand && cur.game?.hand) {
          const before = new Set(prev.game.hand.map((c) => c.id));
          const added = cur.game.hand.filter((c) => !before.has(c.id)).map((c) => c.id);
          hideUntil(document.querySelector(".hand"), added, start + 360);
        }
        later(start + 200, () => {
          if (e.n >= 4) fx.bubble(bubbleAt, `+${e.n}`, "draw-big", 1500);
          if (e.why === "timeout") fx.bubble(bubbleAt, "時間切れ", "timeout");
          if (e.why === "refill") fx.bubble(bubbleAt, "手札0枚 → 2枚補充", "refill");
        });
        t += 150;
        break;
      }
      case "pass":
        if (!e.timeout) later(t, () => fx.bubble(seatOrHand(e.by), "パス", "pass", 1000));
        break;
      case "uno":
        later(t + 250, () => fx.bubble(seatOrHand(e.by), "UNO!", "uno", 1500));
        break;
      case "reshuffle":
        fx.banner(e.added ? "山札を追加！" : "山札を切り直し", "small", "", 1000);
        break;
      case "dobon": {
        const n = e.n;
        const label = DOBON_LABELS[n - 1] ?? `${n}人ドボン`;
        const sub = `${nameOf(e.by)} → ${e.target ? nameOf(e.target) : "初期場札"}`;
        fx.flash(n >= 3 ? "rainbow" : n === 2 ? "gold" : "red");
        fx.shake(true);
        fx.banner(`${label}!!`, n >= 3 ? "triple" : n === 2 ? "double" : "dobon", sub, 1900);
        fx.confetti(n >= 3 ? 130 : n === 2 ? 90 : 50);
        break;
      }
      case "ret": {
        fx.flash("purple");
        fx.shake(true);
        fx.banner("ドボン返し!!", "ret", `${nameOf(e.by)} → ${e.targets.map(nameOf).join("・")}`, 1900);
        fx.confetti(90);
        break;
      }
      case "stamp":
        fx.bubble(seatOrHand(e.by), STAMPS[e.s] ?? "", "stamp", 2400);
        break;
      default:
        break;
    }
  }
  // 自分の番が回ってきた
  const pg = prev?.game;
  const cg = cur.game;
  if (cg && !cg.result && cg.hand) {
    const nowTurn = cg.seats[cg.turn]?.id;
    const prevTurn = pg ? pg.seats[pg.turn]?.id : null;
    if (nowTurn === you && (prevTurn !== you || pg?.no !== cg.no || !!pg?.result)) {
      later(t + 150, () => fx.bubble(where.seat(you) ?? where.hand(), "あなたの番！", "yourturn", 1200));
    }
  }
}
