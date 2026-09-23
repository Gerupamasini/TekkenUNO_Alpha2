// 画面側の状態（サーバーから来た表示データ＋手元の操作状態）
import type { Card } from "../shared/cards.js";
import type { GameView, RoomView } from "../shared/protocol.js";

export type ConnState = "connecting" | "open" | "closed";

export const S = {
  conn: "connecting" as ConnState,
  /** 接続に時間がかかっている（Render 無料プランの起動待ちなど） */
  slow: false,
  offset: 0,
  view: null as RoomView | null,
  /** 重ね出しモード */
  stackMode: false,
  selected: [] as string[],
  /** 送信中（連打防止） */
  busy: false,
  notice: "" as string,
  turnKey: "",
};

export function serverNow(): number {
  return Date.now() + S.offset;
}

export function game(): GameView | null {
  return S.view?.game ?? null;
}

export function me(): string | null {
  return S.view?.you ?? null;
}

export function isHost(): boolean {
  return !!S.view && S.view.host === S.view.you;
}

export function seated(): boolean {
  const g = game();
  return !!g && g.hand !== null;
}

export function currentTurnId(): string | null {
  const g = game();
  if (!g) return null;
  return g.seats[g.turn]?.id ?? null;
}

export function myTurn(): boolean {
  const g = game();
  return !!g && !g.result && seated() && currentTurnId() === me();
}

export function topCard(): Card | null {
  const g = game();
  return g ? g.stack[g.stack.length - 1] ?? null : null;
}

export function nameOf(id: string | null): string {
  if (!id || !S.view) return "";
  const m = S.view.members.find((x) => x.id === id);
  if (m) return m.name;
  const s = S.view.game?.seats.find((x) => x.id === id);
  return s?.name ?? "?";
}

let scheduled = false;
const listeners: (() => void)[] = [];

export function onChange(fn: () => void) {
  listeners.push(fn);
}

/** 次の描画フレームでまとめて描き直す */
export function changed() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    for (const fn of listeners) fn();
  });
}

/** すぐ描き直す（受信直後にアニメーションの位置を合わせるため） */
export function renderNow() {
  scheduled = false;
  for (const fn of listeners) fn();
}
