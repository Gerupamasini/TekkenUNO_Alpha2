// カードの定義と、サーバー・画面の両方で使う小さなルール関数（docs/RULES.md 1章・5章）

export type Color = "R" | "G" | "B" | "Y";
export type CardType = "NUM" | "SKIP" | "REVERSE" | "DRAW2" | "WILD" | "WILD4";

export interface Card {
  id: string;
  type: CardType;
  /** WILD・WILD4 は null */
  color: Color | null;
  /** 数字カードのみ 0〜9 */
  value?: number;
}

export const COLORS: readonly Color[] = ["R", "G", "B", "Y"];

export function isColor(x: unknown): x is Color {
  return x === "R" || x === "G" || x === "B" || x === "Y";
}

export function isWild(c: Card): boolean {
  return c.type === "WILD" || c.type === "WILD4";
}

/** 108枚1セットを作る（並びは未シャッフル）。id は後で振り直す */
export function makeCardSet(): Omit<Card, "id">[] {
  const out: Omit<Card, "id">[] = [];
  for (const color of COLORS) {
    out.push({ type: "NUM", color, value: 0 });
    for (let v = 1; v <= 9; v++) {
      out.push({ type: "NUM", color, value: v }, { type: "NUM", color, value: v });
    }
    for (const type of ["SKIP", "REVERSE", "DRAW2"] as const) {
      out.push({ type, color }, { type, color });
    }
  }
  for (let i = 0; i < 4; i++) out.push({ type: "WILD", color: null });
  for (let i = 0; i < 4; i++) out.push({ type: "WILD4", color: null });
  return out;
}

export function cardPoints(c: Card): number {
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

export function handPoints(cards: readonly Card[]): number {
  let s = 0;
  for (const c of cards) s += cardPoints(c);
  return s;
}

/** 完全に同じカード（種類・色・数字）。WILD同士・WILD4同士は常に同じ */
export function sameCard(a: Card, b: Card): boolean {
  return a.type === b.type && a.color === b.color && (a.value ?? -1) === (b.value ?? -1);
}

/** 重ね出しの2枚目以降：数字カードは同じ数字、記号カードは同じ種類 */
export function sameValueOrEffect(a: Card, b: Card): boolean {
  if (a.type === "NUM" && b.type === "NUM") return a.value === b.value;
  if (a.type !== "NUM" && b.type !== "NUM") return a.type === b.type;
  return false;
}

/**
 * 1枚目として場に出せるか（docs/RULES.md 5章）
 * @param activeColor 場の色。WILD系の場札で色の指定がないときは null（何色でも可）
 */
export function canPlayFirst(top: Card, activeColor: Color | null, pendingDraw: number, c: Card): boolean {
  if (pendingDraw > 0) {
    if (top.type === "DRAW2") return c.type === "DRAW2" || c.type === "WILD4";
    if (top.type === "WILD4") return c.type === "WILD4";
    return false;
  }
  if (isWild(c)) return true;
  const topColor = isWild(top) ? activeColor : top.color;
  if (topColor === null) return true; // 色の指定なし（初期場札のWILD・WILD4）
  if (c.color === topColor) return true;
  if (c.type === "NUM" && top.type === "NUM") return c.value === top.value;
  if (c.type !== "NUM" && top.type !== "NUM") return c.type === top.type;
  return false;
}

/** 出す順に並んだカードが重ね出しとして成立するか（1枚目の適合は別に判定） */
export function isValidStack(cards: readonly Card[]): boolean {
  if (cards.length === 0) return false;
  for (let i = 1; i < cards.length; i++) {
    if (!sameValueOrEffect(cards[i - 1], cards[i])) return false;
  }
  return true;
}

export function cardLabel(c: Card): string {
  const col = c.color ? { R: "赤", G: "緑", B: "青", Y: "黄" }[c.color] : "";
  switch (c.type) {
    case "NUM":
      return `${col}${c.value}`;
    case "SKIP":
      return `${col}スキップ`;
    case "REVERSE":
      return `${col}リバース`;
    case "DRAW2":
      return `${col}ドロー2`;
    case "WILD":
      return "ワイルド";
    case "WILD4":
      return "ドロー4";
  }
}

export function colorName(c: Color | null): string {
  if (!c) return "自由";
  return { R: "赤", G: "緑", B: "青", Y: "黄" }[c];
}
