// ゲーム画面：席・場札・操作ボタン・手札・結果
import {
  type Card,
  canPlayFirst,
  cardPoints,
  colorName,
  handPoints,
  isValidStack,
  isWild,
  sameCard,
  sameValueOrEffect,
} from "../../shared/cards.js";
import { STAMPS, type SeatView } from "../../shared/protocol.js";
import { cardEl, cardKey } from "../cardview.js";
import { cls, h, keyed, rectOf, replace, show, text } from "../dom.js";
import * as fx from "../fx.js";
import { send } from "../net.js";
import { S, changed, currentTurnId, game, isHost, me, myTurn, nameOf, seated, serverNow, topCard } from "../store.js";
import { modal, pickColor } from "./common.js";
import { statsTable } from "./stats.js";

export const DOBON_LABELS = ["ドボン", "ダブロン", "トリロン", "クアドロン", "クインドロン", "セクスロン", "セプトロン", "オクトロン", "ノナロン"];

let root: HTMLElement | null = null;
let tableEl: HTMLElement;
let seatsEl: HTMLElement;
let dirEl: HTMLElement;
let dirLabel: HTMLElement;
let deckEl: HTMLElement;
let deckCount: HTMLElement;
let discardEl: HTMLElement;
let fanEl: HTMLElement;
let lastByEl: HTMLElement;
let colorChip: HTMLElement;
let colorLabel: HTMLElement;
let pendingEl: HTMLElement;
let ptsEl: HTMLElement;
let windowEl: HTMLElement;
let statusEl: HTMLElement;
let statusText: HTMLElement;
let secsEl: HTMLElement;
let actionsEl: HTMLElement;
let handWrap: HTMLElement;
let handEl: HTMLElement;
let resultEl: HTMLElement;
/** いま表示しているゲーム（部屋・自分・ゲーム番号）。変わったら手札と場札を作り直す */
let boardSig = "";
const B = {} as Record<"draw" | "pass" | "dobon" | "stack" | "play" | "stamp" | "queue", HTMLButtonElement>;

// ---------------------------------------------------------------- 手札の並びと選択

const COLOR_RANK: Record<string, number> = { R: 0, G: 1, B: 2, Y: 3 };
function sortHand(cards: Card[]): Card[] {
  return [...cards].sort(
    (a, b) =>
      cardPoints(a) - cardPoints(b) ||
      (COLOR_RANK[a.color ?? ""] ?? 4) - (COLOR_RANK[b.color ?? ""] ?? 4) ||
      a.type.localeCompare(b.type) ||
      (a.value ?? 0) - (b.value ?? 0),
  );
}

function selectedCards(hand: Card[]): Card[] {
  return S.selected.map((id) => hand.find((c) => c.id === id)).filter((c): c is Card => !!c);
}

/** そのカードを今タップで使えるか */
function selectable(c: Card, hand: Card[]): boolean {
  const g = game();
  const top = topCard();
  if (!g || !top || g.result || !seated()) return false;
  if (myTurn()) {
    const sel = selectedCards(hand);
    if (S.stackMode && sel.length > 0) {
      if (S.selected.includes(c.id)) return true;
      return sameValueOrEffect(sel[sel.length - 1], c);
    }
    return canPlayFirst(top, g.color, g.pending, c);
  }
  return g.window && sameCard(c, top);
}

function stackReady(): boolean {
  const g = game();
  const top = topCard();
  if (!g || !g.hand || !top) return false;
  const sel = selectedCards(g.hand);
  if (!sel.length) return false;
  if (myTurn()) return canPlayFirst(top, g.color, g.pending, sel[0]) && isValidStack(sel);
  return g.window && sel.every((c) => sameCard(c, top));
}

async function playCards(cards: Card[]) {
  if (!cards.length || S.busy) return;
  let color: "R" | "G" | "B" | "Y" | undefined;
  if (isWild(cards[cards.length - 1])) {
    const c = await pickColor();
    if (!c) return;
    color = c;
  }
  for (const c of cards) handEl.querySelector(`[data-id="${CSS.escape(c.id)}"]`)?.classList.add("leaving");
  S.busy = send({ t: "play", ids: cards.map((c) => c.id), color });
  S.selected = [];
  S.stackMode = false;
  changed();
}

function onHandClick(e: Event) {
  const el = (e.target as HTMLElement).closest<HTMLElement>(".card");
  const g = game();
  if (!el || !g?.hand || S.busy) return;
  const c = g.hand.find((x) => x.id === el.dataset.id);
  if (!c) return;
  if (!selectable(c, g.hand)) {
    fx.pop(el, "nope");
    return;
  }
  if (S.stackMode) {
    const i = S.selected.indexOf(c.id);
    if (i >= 0) S.selected.splice(i, 1);
    else S.selected.push(c.id);
    changed();
    return;
  }
  void playCards([c]);
}

// ---------------------------------------------------------------- 組み立て

function button(key: keyof typeof B, label: string, klass: string, onclick: () => void) {
  const b = h("button", { class: `btn ${klass}`, type: "button", "aria-label": key === "stamp" ? "スタンプ" : null }, label) as HTMLButtonElement;
  b.addEventListener("click", onclick);
  B[key] = b;
  return b;
}

function openStamps() {
  const close = modal(
    "スタンプ",
    h(
      "div",
      { class: "stamp-grid" },
      ...STAMPS.map((s, i) =>
        h(
          "button",
          {
            class: "btn stamp-btn",
            onclick: () => {
              send({ t: "stamp", s: i });
              close();
            },
          },
          s,
        ),
      ),
    ),
  );
}

export function mountBoard(): HTMLElement {
  if (root) return root;
  seatsEl = h("div", { class: "seats" });
  dirEl = h("div", { class: "dir-ring cw" });
  dirLabel = h("span", { class: "dir-label" });
  deckCount = h("span", { class: "deck-count" });
  deckEl = h("div", { class: "deck-pile" }, cardEl(null, "pile-card"), cardEl(null, "pile-card p2"), deckCount);
  fanEl = h("div", { class: "fan" });
  lastByEl = h("div", { class: "last-by" });
  discardEl = h("div", { class: "discard" }, fanEl);
  colorChip = h("span", { class: "color-chip" });
  colorLabel = h("span", { class: "color-label" });
  pendingEl = h("div", { class: "pending" });
  ptsEl = h("div", { class: "table-pts" });
  windowEl = h("div", { class: "window-tag" }, "ドボン・カットイン受付中");
  const center = h(
    "div",
    { class: "table-center" },
    dirEl,
    h("div", { class: "piles" }, deckEl, discardEl),
    lastByEl,
    h("div", { class: "center-info" }, h("span", { class: "color-box" }, colorChip, colorLabel), ptsEl, dirLabel),
    pendingEl,
    windowEl,
  );
  tableEl = h("div", { class: "table" }, center, seatsEl);
  statusText = h("span", { class: "status-text" });
  secsEl = h("span", { class: "secs" });
  statusEl = h("div", { class: "status" }, statusText, secsEl);
  actionsEl = h(
    "div",
    { class: "actions" },
    button("draw", "ドロー", "act draw", () => {
      S.busy = send({ t: "draw" });
      changed();
    }),
    button("pass", "パス", "act pass", () => {
      S.busy = send({ t: "pass" });
      changed();
    }),
    button("dobon", "ドボン！", "act dobon", () => send({ t: "dobon" })),
    button("stack", "重ね出し", "act stack", () => {
      S.stackMode = !S.stackMode;
      S.selected = [];
      changed();
    }),
    button("play", "出す", "act play primary", () => {
      const g = game();
      if (g?.hand) void playCards(selectedCards(g.hand));
    }),
    button("queue", "次のゲームから参加", "act ghost queue", () => {
      const m = S.view?.members.find((x) => x.id === S.view?.you);
      send({ t: "queue", on: !m?.queued });
    }),
    button("stamp", "💬", "act stamp ghost", openStamps),
  );
  handEl = h("div", { class: "hand" });
  handEl.addEventListener("click", onHandClick);
  handWrap = h("div", { class: "hand-wrap" }, handEl);
  resultEl = h("div", { class: "result", hidden: true });
  root = h("section", { class: "board" }, tableEl, statusEl, actionsEl, handWrap, resultEl);
  const ro = new ResizeObserver(() => {
    layoutSeats();
    fitHand();
  });
  ro.observe(tableEl);
  ro.observe(handWrap);
  return root;
}

// ---------------------------------------------------------------- 席

function seatChip(s: SeatView): HTMLElement {
  return h(
    "div",
    { class: "seat", dataset: { id: s.id } },
    h("div", { class: "seat-ring" }),
    h("div", { class: "seat-name" }),
    h("div", { class: "seat-meta" }, h("span", { class: "mini-back" }), h("b", { class: "seat-count" }), h("span", { class: "seat-unit" }, "枚")),
    h("div", { class: "seat-pts" }),
    h("span", { class: "seat-tag" }),
  );
}

function orderedSeats(): SeatView[] {
  const g = game()!;
  const i = g.seats.findIndex((s) => s.id === me());
  if (i < 0) return g.seats;
  return [...g.seats.slice(i), ...g.seats.slice(0, i)];
}

function nextTurnId(): string | null {
  const g = game();
  if (!g || g.result) return null;
  const n = g.seats.length;
  return g.seats[(((g.turn + g.dir) % n) + n) % n]?.id ?? null;
}

function renderSeats() {
  const g = game()!;
  const cur = g.result ? null : currentTurnId();
  const next = nextTurnId();
  const you = me();
  const hostId = S.view!.host;
  cls(tableEl, "many", g.seats.length >= 7);
  keyed(seatsEl, orderedSeats(), (s) => s.id, seatChip, (el, s) => {
    const isMe = s.id === you;
    cls(el, "me", isMe);
    cls(el, "turn", s.id === cur);
    cls(el, "next", s.id === next && s.id !== cur);
    cls(el, "last", s.id === g.lastBy && !g.result);
    cls(el, "offline", !s.online);
    cls(el, "gone", s.gone);
    cls(el, "uno", s.count === 1);
    text(el.querySelector(".seat-name")!, (s.id === hostId ? "👑" : "") + s.name);
    text(el.querySelector(".seat-count")!, String(s.count));
    const pts = el.querySelector(".seat-pts")!;
    text(pts, isMe && g.hand ? `手札点 ${handPoints(g.hand)}` : "");
    let tag = "";
    if (s.gone) tag = "退室";
    else if (!s.online) tag = "切断中";
    else if (s.count === 1) tag = "UNO";
    else if (s.id === next && s.id !== cur) tag = "NEXT";
    else if (isMe) tag = "あなた";
    text(el.querySelector(".seat-tag")!, tag);
  });
  layoutSeats();
}

/** 楕円の周上で、下（自分の位置）から時計回りに弧の長さ t（0〜1）進んだ点の角度 */
function ellipseAngles(rx: number, ry: number) {
  const N = 360;
  const acc: number[] = [0];
  let px = 0;
  let py = ry;
  for (let i = 1; i <= N; i++) {
    const a = Math.PI / 2 + (2 * Math.PI * i) / N;
    const x = rx * Math.cos(a);
    const y = ry * Math.sin(a);
    acc.push(acc[i - 1] + Math.hypot(x - px, y - py));
    px = x;
    py = y;
  }
  const total = acc[N];
  return (t: number) => {
    const target = t * total;
    let lo = 0;
    let hi = N;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (acc[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    return Math.PI / 2 + (2 * Math.PI * lo) / N;
  };
}

/** 席を楕円に並べる（自分は一番下、そこから時計回り。弧の長さで等間隔） */
function layoutSeats() {
  if (!root) return;
  const W = tableEl.clientWidth;
  const H = tableEl.clientHeight;
  const chips = Array.from(seatsEl.children) as HTMLElement[];
  const n = chips.length;
  if (!n || !W || !H) return;
  let cw = 0;
  let ch = 0;
  for (const el of chips) {
    cw = Math.max(cw, el.offsetWidth);
    ch = Math.max(ch, el.offsetHeight);
  }
  const rx = Math.max(20, W / 2 - cw / 2 - 6);
  const ry = Math.max(20, H / 2 - ch / 2 - 8);
  const angleAt = ellipseAngles(rx, ry);
  // 自分（一番下）の両隣は少し広く空ける（人数が多いと自分の席と重なるため）
  const withMe = chips[0]?.classList.contains("me");
  const step = 1 / n;
  const gap = withMe && n >= 7 ? step * 1.35 : step;
  const rest = n > 2 ? (1 - 2 * gap) / (n - 2) : step;
  chips.forEach((el, i) => {
    let t: number;
    if (!withMe) t = step * i;
    else if (i === 0) t = 0;
    else t = gap + rest * (i - 1);
    const a = angleAt(t);
    const x = W / 2 + rx * Math.cos(a) - el.offsetWidth / 2;
    const y = H / 2 + ry * Math.sin(a) - el.offsetHeight / 2;
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  });
}

// ---------------------------------------------------------------- 場

function renderCenter() {
  const g = game()!;
  text(deckCount, String(g.deck));
  const n = g.stack.length;
  keyed(fanEl, g.stack, cardKey, (c) => cardEl(c, "fan-card"), (el, _c, i) => {
    el.style.setProperty("--i", String(i - (n - 1)));
    el.style.zIndex = String(10 + i);
  });
  cls(fanEl, "multi", n > 1);
  const lastBy = g.lastBy;
  text(lastByEl, lastBy ? `${nameOf(lastBy)}${g.cutin ? "（カットイン）" : ""}${n > 1 ? `・${n}枚重ね` : ""}` : "初期場札");
  colorChip.className = `color-chip ${g.color ? `c-${g.color}` : "c-free"}`;
  text(colorLabel, g.color ? `${colorName(g.color)}` : "色自由");
  discardEl.className = `discard glow-${g.color ?? "free"}`;
  text(ptsEl, `場札点 ${g.tablePts}`);
  show(pendingEl, g.pending > 0 && !g.result);
  text(pendingEl, `+${g.pending}`);
  cls(pendingEl, "hot", g.pending >= 8);
  cls(pendingEl, "fire", g.pending >= 12);
  dirEl.className = `dir-ring ${g.dir === 1 ? "cw" : "ccw"}`;
  replace(dirLabel, g.dir === 1 ? "↻" : "↺", h("span", { class: "dir-text" }, g.dir === 1 ? " 時計回り" : " 反時計回り"));
  cls(dirLabel, "ccw", g.dir !== 1);
  show(windowEl, g.window && !g.result);
}

// ---------------------------------------------------------------- 状況の一文

function statusLine(): string {
  const g = game()!;
  const top = topCard()!;
  if (g.result) return "";
  const cur = currentTurnId();
  const curName = nameOf(cur);
  if (!seated()) return `観戦中：${curName}の番`;
  const hand = g.hand ?? [];
  if (myTurn()) {
    if (g.pending > 0) {
      const canAnswer = hand.some((c) => canPlayFirst(top, g.color, g.pending, c));
      const how = top.type === "WILD4" ? "ドロー4" : "ドロー2かドロー4";
      return canAnswer ? `あなたの番：累積+${g.pending}！${how}で返すか、引いてください` : `あなたの番：累積+${g.pending}。返せないので引いてください`;
    }
    if (S.stackMode) return S.selected.length ? `重ね出し：${S.selected.length}枚選択中（最後の1枚が場札になります）` : "重ね出し：1枚目を選んでください";
    if (g.drew) return "引いた後も好きなカードを出せます。出さないならパス";
    return hand.some((c) => canPlayFirst(top, g.color, g.pending, c)) ? "あなたの番：光っているカードを出せます" : "あなたの番：出せるカードがありません。ドローしてください";
  }
  if (g.window && hand.some((c) => sameCard(c, top))) return `カットインできます！（${curName}の番）`;
  return `${curName}の番`;
}

// ---------------------------------------------------------------- ボタン

function renderActions() {
  const g = game()!;
  const isSeated = seated();
  const inResult = !!g.result;
  const mine = myTurn();
  for (const k of ["draw", "pass", "dobon", "stack", "play"] as const) show(B[k], isSeated && !inResult);
  show(B.play, isSeated && !inResult && S.stackMode);
  show(B.stamp, !(isSeated && S.stackMode));
  const spectatorMe = S.view!.members.find((m) => m.id === S.view!.you);
  show(B.queue, !isSeated && S.view!.role === "spectator");
  text(B.queue, spectatorMe?.queued ? "参加予約をやめる" : "次のゲームから参加");
  B.draw.disabled = S.busy || !mine || !(g.pending > 0 || !g.drew);
  text(B.draw, g.pending > 0 ? `+${g.pending} 引く` : "ドロー");
  cls(B.draw, "emph", mine && (g.pending > 0 || !g.drew));
  B.pass.disabled = S.busy || !mine || !g.drew || g.pending > 0;
  cls(B.pass, "emph", mine && g.drew && g.pending === 0);
  B.dobon.disabled = !g.canDobon;
  cls(B.stack, "on", S.stackMode);
  text(B.stack, S.stackMode ? "やめる" : "重ね出し");
  B.stack.disabled = !g.hand || g.hand.length < 2;
  B.play.disabled = S.busy || !stackReady();
  text(B.play, S.selected.length ? `${S.selected.length}枚出す` : "出す");
}

// ---------------------------------------------------------------- 手札

function renderHand() {
  const g = game()!;
  const hand = g.hand;
  show(handWrap, !!hand);
  if (!hand) {
    // 観戦中（キックのあと観戦で戻った場合など）は前の手札を残さない
    if (handEl.firstChild) handEl.replaceChildren();
    return;
  }
  const sorted = sortHand(hand);
  const mine = myTurn();
  keyed(handEl, sorted, cardKey, (c) => cardEl(c, "hand-card"), (el, c) => {
    const ok = selectable(c, hand);
    const cutin = !mine && ok;
    cls(el, "playable", ok);
    cls(el, "cutin", cutin);
    cls(el, "dim", (mine || S.stackMode) && !ok && !g.result);
    const si = S.selected.indexOf(c.id);
    cls(el, "selected", si >= 0);
    if (si >= 0) el.dataset.order = String(si + 1);
    else delete el.dataset.order;
    el.classList.remove("leaving");
  });
  cls(handWrap, "my-turn", mine);
  fitHand();
}

/** 枚数が多いときは重ねて表示（それでも入りきらなければ横スクロール） */
function fitHand() {
  if (!root) return;
  const cards = handEl.children;
  const n = cards.length;
  if (!n) return;
  const cw = (cards[0] as HTMLElement).offsetWidth;
  const avail = handWrap.clientWidth - 24;
  let ov = 6;
  if (n > 1 && n * (cw + 6) > avail) {
    const need = (n * cw - avail) / (n - 1);
    ov = -Math.min(cw * 0.62, need);
  }
  handEl.style.setProperty("--gap", `${ov}px`);
  cls(handEl, "overflow", n > 1 && n * cw + (n - 1) * ov > avail + 2);
}

// ---------------------------------------------------------------- 結果

let resultSig = "";
function markText(mark: string, n: number, zero: boolean): string {
  switch (mark) {
    case "DOBON":
      return "★ドボン";
    case "BEDOBON":
      return "◎".repeat(Math.max(1, n)) + "被ドボン";
    case "DOBON_RETURN":
      return "★ドボン返し";
    case "BEDOBON_RETURN":
      return "◎返された";
    default:
      return zero ? "0点！" : "";
  }
}

function renderResult() {
  const g = game()!;
  const r = g.result;
  show(resultEl, !!r);
  if (!r) {
    resultSig = "";
    return;
  }
  const sig = JSON.stringify([g.no, r.by, r.ret, r.final, r.rows.map((x) => x.score)]);
  if (sig === resultSig) {
    updateResultButtons();
    return;
  }
  const first = !resultSig.startsWith(JSON.stringify([g.no]).slice(0, -1));
  resultSig = sig;
  const n = r.by.length;
  const title = r.ret ? "ドボン返し!!" : `${DOBON_LABELS[n - 1] ?? `${n}人ドボン`}!!`;
  const sub = r.ret
    ? `${nameOf(r.ret)} → ${r.by.map(nameOf).join("・")}`
    : `${r.by.map(nameOf).join("・")} → ${r.target ? nameOf(r.target) : "初期場札（被ドボンなし）"}`;
  const rows = [...r.rows].sort((a, b) => a.score - b.score);
  const tbody = h("tbody");
  rows.forEach((row, i) => {
    const scoreCell = h("td", { class: "score" }, "0");
    tbody.appendChild(
      h(
        "tr",
        { class: `${row.id === me() ? "me " : ""}m-${row.mark}${row.zero ? " zero" : ""}` },
        h("td", { class: "name" }, row.name),
        h("td", null, String(row.hand)),
        scoreCell,
        h("td", { class: "mark" }, markText(row.mark, n, row.zero)),
      ),
    );
    fx.countUp(scoreCell, row.score, 650, first ? 900 + i * 90 : i * 60);
  });
  const btns = h("div", { class: "row center result-btns" });
  replace(
    resultEl,
    h(
      "div",
      { class: `result-card ${r.ret ? "k-ret" : n >= 3 ? "k-triple" : n === 2 ? "k-double" : "k-dobon"}` },
      h("div", { class: "result-title" }, title),
      h("div", { class: "result-sub" }, `${sub}（場札点 ${r.pts}）`),
      h("div", { class: "result-timer" }, h("div", { class: "bar" }), h("span", { class: "timer-text" })),
      h(
        "div",
        { class: "table-scroll" },
        h("table", { class: "result-table" }, h("thead", null, h("tr", null, h("th", null, "名前"), h("th", null, "手札点"), h("th", null, "得点"), h("th", null, ""))), tbody),
      ),
      btns,
    ),
  );
  const ret = h("button", { class: "btn act dobon ret", type: "button", onclick: () => send({ t: "ret" }) }, "ドボン返し！");
  const dob = h("button", { class: "btn act dobon", type: "button", onclick: () => send({ t: "dobon" }) }, "ドボン！（追加）");
  const next = h("button", { class: "btn primary", type: "button", onclick: () => send({ t: "next" }) }, "次のゲームへ");
  const stats = h(
    "button",
    {
      class: "btn ghost",
      type: "button",
      onclick: () => modal("成績（このルーム）", statsTable(S.view!.stats, me()), { wide: true }),
    },
    "成績",
  );
  btns.append(ret, dob, next, stats);
  updateResultButtons();
}

function updateResultButtons() {
  const g = game();
  const r = g?.result;
  if (!g || !r) return;
  const btns = resultEl.querySelector(".result-btns");
  if (!btns) return;
  const [ret, dob, next] = Array.from(btns.children) as HTMLButtonElement[];
  show(ret, !r.final && !r.ret && r.target === me());
  show(dob, !r.final && !r.ret && seated() && r.target !== me() && !r.by.includes(me() ?? ""));
  dob.disabled = !g.canDobon;
  show(next, r.final && (seated() || isHost()));
  const timerText = resultEl.querySelector(".timer-text");
  if (timerText && r.final) text(timerText, "結果確定");
  cls(resultEl.querySelector(".result-timer")!, "done", r.final);
}

// ---------------------------------------------------------------- 時間表示（10回/秒）

let timerHandle = 0;
function tickTimer() {
  const g = game();
  if (!g || !root) return;
  const now = serverNow();
  if (!g.result) {
    const total = Math.max(1000, g.deadline - g.started);
    const left = Math.max(0, g.deadline - now);
    text(secsEl, `${Math.ceil(left / 1000)}秒`);
    cls(secsEl, "warn", left < 5000);
    const cur = seatsEl.querySelector<HTMLElement>(".seat.turn");
    cur?.style.setProperty("--p", String(left / total));
    cls(statusEl, "warn", myTurn() && left < 5000);
  } else if (!g.result.final) {
    const left = Math.max(0, g.result.deadline - now);
    const bar = resultEl.querySelector<HTMLElement>(".result-timer .bar");
    bar?.style.setProperty("--p", String(left / 10_000));
    const t = resultEl.querySelector(".timer-text");
    if (t) text(t, `追加ドボン・ドボン返し受付中 ${Math.ceil(left / 1000)}秒`);
  }
}

// ---------------------------------------------------------------- 全体

export function updateBoard() {
  const g = game();
  if (!root || !g) return;
  // 新しいゲーム（または別の部屋）になったら、前のゲームのカードの要素を残さない
  const sig = `${S.view!.key}|${S.view!.you}|${g.no}`;
  if (sig !== boardSig) {
    boardSig = sig;
    handEl.replaceChildren();
    fanEl.replaceChildren();
  }
  const top = topCard();
  const key = `${g.no}|${g.turn}|${top?.id}|${g.pending}|${!!g.result}`;
  if (key !== S.turnKey) {
    S.turnKey = key;
    S.stackMode = false;
    S.selected = [];
  }
  S.selected = g.hand ? S.selected.filter((id) => g.hand!.some((c) => c.id === id)) : [];
  if (!g.hand) S.stackMode = false;
  cls(root, "spectating", !seated());
  renderSeats();
  renderCenter();
  text(statusText, statusLine());
  show(statusEl, !g.result);
  renderActions();
  renderHand();
  renderResult();
  tickTimer();
  if (!timerHandle) timerHandle = window.setInterval(tickTimer, 100);
}

export function stopBoard() {
  clearInterval(timerHandle);
  timerHandle = 0;
}

// ---------------------------------------------------------------- 演出から使う位置

export const where = {
  seat: (id: string | null) => (id ? rectOf(seatsEl?.querySelector(`.seat[data-key="${CSS.escape(id)}"]`) ?? null) : null),
  handCard: (id: string) => rectOf(handEl?.querySelector(`[data-id="${CSS.escape(id)}"]`) ?? null),
  hand: () => rectOf(handWrap ?? null),
  deck: () => rectOf(deckEl ?? null),
  discard: () => rectOf(discardEl ?? null),
  fan: () => fanEl ?? null,
  pending: () => pendingEl ?? null,
  dir: () => dirEl ?? null,
  status: () => rectOf(statusEl ?? null),
};
