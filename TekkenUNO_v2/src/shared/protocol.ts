// サーバーと画面の間でやり取りするメッセージの型
import type { Card, Color } from "./cards.js";
import type { GameEvent, Mark } from "./engine.js";

export const MAX_PLAYERS = 10;
export const MAX_SPECTATORS = 20;
export const NAME_MAX = 12;
export const KEY_MAX = 32;

/** スタンプ（番号で送る） */
export const STAMPS = ["ナイス！", "うそでしょ", "やられた…", "ドボン待ち", "はやく〜", "ごめん", "www", "おつかれ"] as const;

// ---------- 画面 → サーバー ----------
export type ClientMsg =
  | { t: "hello"; token: string; build: string }
  | { t: "join"; key: string; name: string; spectate?: boolean }
  | { t: "leave" }
  | { t: "name"; name: string }
  | { t: "role"; spectate: boolean }
  | { t: "queue"; on: boolean }
  | { t: "start" }
  | { t: "end" }
  | { t: "next" }
  | { t: "kick"; id: string }
  | { t: "play"; ids: string[]; color?: Color }
  | { t: "draw" }
  | { t: "pass" }
  | { t: "dobon" }
  | { t: "ret" }
  | { t: "stamp"; s: number }
  | { t: "ping"; c: number };

// ---------- サーバー → 画面 ----------
export type ServerMsg =
  | { t: "hello"; you: string | null; now: number; build: string }
  | { t: "state"; s: RoomView; ev: EventView[] }
  | { t: "err"; m: string }
  | { t: "pong"; c: number; s: number }
  | { t: "out"; why: "left" | "kicked" };

export type EventView =
  | GameEvent
  | { e: "stamp"; by: string; s: number }
  | { e: "sys"; m: string };

export interface MemberView {
  id: string;
  name: string;
  role: "player" | "spectator";
  online: boolean;
  queued: boolean;
}

export interface SeatView {
  id: string;
  name: string;
  count: number;
  online: boolean;
  /** キックなどで部屋にいない（席だけ残っている） */
  gone: boolean;
}

export interface ResultRow {
  id: string;
  name: string;
  hand: number;
  score: number;
  mark: Mark;
  zero: boolean;
  /** ドボンが決まったときに累積を引いた枚数（引いていなければ0） */
  drew: number;
}

export interface ResultView {
  target: string | null;
  by: string[];
  ret: string | null;
  pts: number;
  deadline: number;
  final: boolean;
  rows: ResultRow[];
}

export interface GameView {
  no: number;
  seats: SeatView[];
  turn: number;
  dir: 1 | -1;
  /** 直前の1回で出されたカード（最後が場札） */
  stack: Card[];
  lastBy: string | null;
  cutin: boolean;
  tablePts: number;
  /** 場の色。null は色の指定なし（何でも出せる） */
  color: Color | null;
  pending: number;
  drew: boolean;
  /** 今の手番が始まった時刻（サーバー時刻） */
  started: number;
  deadline: number;
  window: boolean;
  /** あなたがドボンボタンを押せるか（点数は見ていない） */
  canDobon: boolean;
  deck: number;
  hand: Card[] | null;
  result: ResultView | null;
}

export interface StatRow {
  id: string;
  name: string;
  games: number;
  total: number;
  max: number;
  dobon: number;
  bedobon: number;
}

/** 試合ごとの記録（成績の「試合別」） */
export interface MatchRow {
  /** 今いる人なら今の id（自分の行を見分けるため）。いなければ試合のときの id */
  id: string;
  name: string;
  hand: number;
  score: number;
  mark: Mark;
  zero: boolean;
  drew: number;
}
export interface MatchView {
  no: number;
  at: number;
  /** 場札点 */
  pts: number;
  /** 被ドボン者・ドボンした人・ドボン返しした人（rows の id） */
  target: string | null;
  by: string[];
  ret: string | null;
  rows: MatchRow[];
}

export interface LogLine {
  t: number;
  m: string;
}

export interface RoomView {
  key: string;
  phase: "LOBBY" | "PLAYING" | "RESULT";
  host: string;
  you: string;
  role: "player" | "spectator";
  members: MemberView[];
  game: GameView | null;
  stats: StatRow[];
  games: number;
  /** 試合ごとの記録。変わったとき（と接続した直後）だけ付けて送る */
  matches?: MatchView[];
  log: LogLine[];
}
