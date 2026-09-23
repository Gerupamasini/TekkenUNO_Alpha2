// 結果・成績で使う言葉（ゲーム画面・演出・成績で共有）

export const DOBON_LABELS = ["ドボン", "ダブロン", "トリロン", "クアドロン", "クインドロン", "セクスロン", "セプトロン", "オクトロン", "ノナロン"];

/** n人ドボンの呼び名 */
export function dobonLabel(n: number): string {
  return DOBON_LABELS[n - 1] ?? `${n}人ドボン`;
}

/** 結果の行の印（取説：された人は丸、2人からなら二重丸…） */
export function markText(mark: string, n: number, zero: boolean): string {
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

/** ドボンで累積を引いた人の手札点に添える注記 */
export function drewNote(n: number): string {
  return n > 0 ? `+${n}枚` : "";
}
