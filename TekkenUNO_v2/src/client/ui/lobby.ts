// ロビー：参加者・観戦者の一覧、START、キック、成績
import { MAX_PLAYERS, type MemberView } from "../../shared/protocol.js";
import { h, keyed, show, text } from "../dom.js";
import { send } from "../net.js";
import { S, isHost } from "../store.js";
import { confirmBox } from "./common.js";
import { statsView } from "./stats.js";
import { versionFoot } from "./version.js";

let root: HTMLElement | null = null;
let playersEl: HTMLElement;
let specsEl: HTMLElement;
let playersTitle: HTMLElement;
let specsTitle: HTMLElement;
let startBtn: HTMLButtonElement;
let waitEl: HTMLElement;
let roleBtn: HTMLButtonElement;
let stats: ReturnType<typeof statsView>;

/** キックの確認。キックは入室禁止ではない（合言葉を入れ直せば戻れる） */
export async function confirmKick(target: MemberView) {
  const v = S.view;
  const m = v?.members.find((x) => x.id === target.id) ?? target;
  const inGame = v?.phase === "PLAYING" && !!v.game?.seats.some((s) => s.id === m.id);
  const note = inGame ? "この試合の席は最後まで自動で進みます。" : "";
  if (await confirmBox(`${m.name}をキックしますか？${note}（本人は合言葉を入れ直せば戻ってこられます）`, "キックする", true)) send({ t: "kick", id: m.id });
}

function memberRow(m: MemberView): HTMLElement {
  const kick = h("button", { class: "btn tiny ghost kick" }, "キック");
  kick.addEventListener("click", () => confirmKick(m));
  return h(
    "li",
    { class: "member" },
    h("span", { class: "dot" }),
    h("span", { class: "mname" }),
    h("span", { class: "mbadges" }),
    kick,
  );
}

function updateRow(el: HTMLElement, m: MemberView) {
  const v = S.view!;
  el.classList.toggle("offline", !m.online);
  el.classList.toggle("me", m.id === v.you);
  text(el.querySelector(".mname")!, m.name);
  const badges: string[] = [];
  if (m.id === v.host) badges.push("ホスト");
  if (m.id === v.you) badges.push("あなた");
  if (!m.online) badges.push("切断中");
  if (m.role === "spectator" && m.queued) badges.push("次ゲーム参加予約");
  text(el.querySelector(".mbadges")!, badges.join("・"));
  show(el.querySelector(".kick") as HTMLElement, isHost() && m.id !== v.you);
}

export function mountLobby(): HTMLElement {
  if (root) return root;
  playersEl = h("ul", { class: "members" });
  specsEl = h("ul", { class: "members" });
  playersTitle = h("h3", null);
  specsTitle = h("h3", null);
  startBtn = h("button", { class: "btn primary big start", onclick: () => send({ t: "start" }) }, "ゲームを始める") as HTMLButtonElement;
  waitEl = h("p", { class: "muted wait" }, "ホストの開始を待っています…");
  roleBtn = h("button", { class: "btn ghost" }) as HTMLButtonElement;
  roleBtn.addEventListener("click", () => {
    send({ t: "role", spectate: S.view?.role === "player" });
  });
  stats = statsView();
  root = h(
    "section",
    { class: "lobby" },
    h(
      "div",
      { class: "panel" },
      h("h2", null, "ロビー"),
      playersTitle,
      playersEl,
      specsTitle,
      specsEl,
      h("div", { class: "row wrap" }, startBtn, roleBtn),
      waitEl,
    ),
    h("div", { class: "panel" }, h("h2", null, "成績（このルーム）"), stats.el),
    h(
      "div",
      { class: "panel rules" },
      h("h2", null, "ルールのポイント"),
      h(
        "ul",
        null,
        h("li", null, "手札が0枚になっても上がりではなく、2枚引きます。上がれるのはドボンだけ。"),
        h("li", null, "ドボン：直前に出されたカードの点数（重ね出しなら合計）と自分の手札の合計が同じなら宣言できます。"),
        h("li", null, "点数：数字はその数、スキップ・リバース・ドロー2は20、ワイルド30、ドロー4は50。"),
        h("li", null, "同じ数字・同じ種類のカードは色違いでも重ねて出せます。"),
        h("li", null, "場札と完全に同じカードは、手番でなくてもカットインで出せます。"),
        h("li", null, "ドロー2・ドロー4は重ねて次の人に回せます。引いた直後はドボンできません。"),
      ),
      versionFoot(),
    ),
  );
  return root;
}

export function updateLobby() {
  if (!root || !S.view) return;
  const v = S.view;
  const players = v.members.filter((m) => m.role === "player");
  const specs = v.members.filter((m) => m.role === "spectator");
  text(playersTitle, `参加者 ${players.length}/${MAX_PLAYERS}`);
  text(specsTitle, `観戦者 ${specs.length}`);
  keyed(playersEl, players, (m) => m.id, memberRow, updateRow);
  keyed(specsEl, specs, (m) => m.id, memberRow, updateRow);
  show(specsTitle, specs.length > 0);
  const host = isHost();
  const onlinePlayers = players.filter((m) => m.online).length + specs.filter((m) => m.queued && m.online).length;
  show(startBtn, host);
  startBtn.disabled = onlinePlayers < 2;
  text(startBtn, onlinePlayers < 2 ? "あと1人以上必要" : "ゲームを始める");
  show(waitEl, !host);
  text(roleBtn, v.role === "player" ? "観戦に回る" : "参加する");
  stats.update();
}
