// 成績表（ルームがある間だけ。docs/RULES.md 13章）
import type { StatRow } from "../../shared/protocol.js";
import { h } from "../dom.js";

function pct(n: number, d: number) {
  return d ? `${Math.round((n / d) * 100)}%` : "-";
}

export function statsTable(rows: StatRow[], you: string | null): HTMLElement {
  if (!rows.length) return h("p", { class: "muted" }, "まだ記録された試合はありません。ドボンで決着した試合だけが記録されます。");
  return h(
    "div",
    { class: "table-scroll" },
    h(
      "table",
      { class: "stats" },
      h(
        "thead",
        null,
        h("tr", null, h("th", null, "名前"), h("th", null, "試合"), h("th", null, "累計"), h("th", null, "平均"), h("th", null, "最高"), h("th", null, "ドボン"), h("th", null, "被ドボン")),
      ),
      h(
        "tbody",
        null,
        ...rows.map((r) =>
          h(
            "tr",
            { class: r.id === you ? "me" : "" },
            h("td", { class: "name" }, r.name),
            h("td", null, String(r.games)),
            h("td", null, String(r.total)),
            h("td", null, (r.total / r.games).toFixed(1)),
            h("td", null, String(r.max)),
            h("td", null, `${r.dobon}`, h("small", null, ` ${pct(r.dobon, r.games)}`)),
            h("td", null, `${r.bedobon}`, h("small", null, ` ${pct(r.bedobon, r.games)}`)),
          ),
        ),
      ),
    ),
  );
}
