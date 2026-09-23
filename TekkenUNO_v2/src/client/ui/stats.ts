// 成績（ルームがある間だけ。docs/RULES.md 13章）：「通算」と「試合別」
import type { MatchView, StatRow } from "../../shared/protocol.js";
import { cls, h, replace, show, text } from "../dom.js";
import { S, onChange } from "../store.js";
import { modal } from "./common.js";
import { dobonLabel, drewNote, markText } from "./labels.js";

type Tab = "total" | "games";
/** 最後に選んだタブ（開き直しても同じタブから） */
let lastTab: Tab = "total";

const EMPTY = "まだ記録された試合はありません。ドボンで決着した試合だけが記録されます。";

function pct(n: number, d: number) {
  return d ? `${Math.round((n / d) * 100)}%` : "-";
}

/** 通算の表 */
export function statsTable(rows: StatRow[], you: string | null): HTMLElement {
  if (!rows.length) return h("p", { class: "muted" }, EMPTY);
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

/** 1試合ぶんの記録（結果画面と同じ並び・印） */
function matchCard(m: MatchView, you: string | null): HTMLElement {
  const n = m.by.length;
  const nameOf = (id: string | null) => m.rows.find((r) => r.id === id)?.name ?? "?";
  const kind = m.ret ? "ドボン返し" : m.target ? dobonLabel(n) : `初期場札に${dobonLabel(n)}`;
  const who = m.ret
    ? `${nameOf(m.ret)} → ${m.by.map(nameOf).join("・")}`
    : `${m.by.map(nameOf).join("・")} → ${m.target ? nameOf(m.target) : "初期場札（被ドボンなし）"}`;
  const time = new Date(m.at).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
  const rows = [...m.rows].sort((a, b) => a.score - b.score);
  return h(
    "article",
    { class: `match ${m.ret ? "k-ret" : n >= 2 ? "k-multi" : "k-dobon"}` },
    h("div", { class: "match-head" }, h("b", { class: "match-no" }, `ゲーム${m.no}`), h("span", { class: "match-kind" }, kind), h("span", { class: "match-time" }, time)),
    h("div", { class: "match-sub" }, `${who}（場札点 ${m.pts}）`),
    h(
      "div",
      { class: "table-scroll" },
      h(
        "table",
        { class: "result-table match-table" },
        h("thead", null, h("tr", null, h("th", null, "名前"), h("th", null, "手札点"), h("th", null, "得点"), h("th", null, ""))),
        h(
          "tbody",
          null,
          ...rows.map((row) =>
            h(
              "tr",
              { class: `${row.id === you ? "me " : ""}m-${row.mark}${row.zero ? " zero" : ""}` },
              h("td", { class: "name" }, row.name),
              h("td", { class: "hand-pts" }, String(row.hand), row.drew ? h("small", { class: "drew", title: "ドボンが決まったときに累積を引いた" }, drewNote(row.drew)) : null),
              h("td", { class: "score" }, String(row.score)),
              h("td", { class: "mark" }, markText(row.mark, n, row.zero)),
            ),
          ),
        ),
      ),
    ),
  );
}

/** 「通算／試合別」を切り替えられる成績の表示。update() を呼ぶと最新にする */
export function statsView(): { el: HTMLElement; update: () => void } {
  let tab: Tab = lastTab;
  const btnTotal = h("button", { class: "seg-btn", type: "button", role: "tab" }, "通算") as HTMLButtonElement;
  const btnGames = h("button", { class: "seg-btn", type: "button", role: "tab" }, "試合別") as HTMLButtonElement;
  const note = h("p", { class: "stats-note", hidden: true });
  const body = h("div", { class: "stats-body" });
  const el = h("div", { class: "stats-view" }, h("div", { class: "seg", role: "tablist" }, btnTotal, btnGames), note, body);
  let sig: unknown[] = [];

  const update = () => {
    const v = S.view;
    if (!v) return;
    cls(btnTotal, "on", tab === "total");
    cls(btnGames, "on", tab === "games");
    btnTotal.setAttribute("aria-selected", String(tab === "total"));
    btnGames.setAttribute("aria-selected", String(tab === "games"));
    text(btnGames, S.matches.length ? `試合別（${S.matches.length}）` : "試合別");
    // まだ記録されていない試合があることを書いておく（成績がずれて見えないように）
    const g = v.game;
    const pending = g && !g.result?.final ? `いまのゲーム（ゲーム${g.no}）は、結果が確定してから記録されます。` : "";
    text(note, pending);
    show(note, !!pending);
    const statsJson = JSON.stringify(v.stats);
    const next = [tab, statsJson, S.matches, v.you];
    if (next.every((x, i) => x === sig[i])) return;
    sig = next;
    if (tab === "total") replace(body, statsTable(v.stats, v.you));
    else if (!S.matches.length) replace(body, h("p", { class: "muted" }, EMPTY));
    else replace(body, h("div", { class: "matches" }, ...S.matches.map((m) => matchCard(m, v.you))));
  };
  const select = (t: Tab) => {
    tab = t;
    lastTab = t;
    update();
  };
  btnTotal.addEventListener("click", () => select("total"));
  btnGames.addEventListener("click", () => select("games"));
  return { el, update };
}

/** 成績のモーダル。開いている間はサーバーから届くたびに更新する */
export function openStats() {
  const sv = statsView();
  sv.update();
  const off = onChange(sv.update);
  modal("成績（このルーム）", sv.el, { wide: true, onClose: off });
}
