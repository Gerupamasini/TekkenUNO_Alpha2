// 部屋の画面の外枠：上のバー、メニュー、ロビーとゲーム画面の切り替え
import { NAME_MAX } from "../../shared/protocol.js";
import { cls, h, replace, show, text } from "../dom.js";
import { leaveRoom, send } from "../net.js";
import { S, isHost, seated } from "../store.js";
import { confirmBox, copyText, modal, promptBox, toast } from "./common.js";
import { mountBoard, stopBoard, updateBoard } from "./game.js";
import { confirmKick, mountLobby, updateLobby } from "./lobby.js";
import { openStats } from "./stats.js";
import { openVersion } from "./version.js";
import { VERSION } from "../version.js";

let root: HTMLElement | null = null;
let mainEl: HTMLElement;
let keyBtn: HTMLButtonElement;
let gameNoEl: HTMLElement;
let connEl: HTMLElement;
let showKey = false;
let mode: "lobby" | "board" | null = null;

function inviteUrl(): string {
  return `${location.origin}/#${encodeURIComponent(S.view?.key ?? "")}`;
}

function openLog() {
  const lines = [...(S.view?.log ?? [])].reverse();
  modal(
    "ログ",
    h(
      "ol",
      { class: "log" },
      ...lines.map((l) => h("li", null, h("time", null, new Date(l.t).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit" })), l.m)),
    ),
    { wide: true },
  );
}

/** ゲーム中・結果画面でのキック（ロビーではメンバー一覧から） */
function openKick() {
  const v = S.view;
  if (!v) return;
  const seatIds = new Set(v.game?.seats.map((s) => s.id) ?? []);
  const others = v.members.filter((m) => m.id !== v.you);
  const list = h(
    "ul",
    { class: "members" },
    ...others.map((m) =>
      h(
        "li",
        { class: `member${m.online ? "" : " offline"}` },
        h("span", { class: "dot" }),
        h("span", { class: "mname" }, m.name),
        h("span", { class: "mbadges" }, [seatIds.has(m.id) ? "参加中" : "観戦", m.online ? "" : "切断中"].filter(Boolean).join("・")),
        h(
          "button",
          {
            class: "btn tiny ghost kick",
            type: "button",
            onclick: () => {
              close();
              confirmKick(m);
            },
          },
          "キック",
        ),
      ),
    ),
  );
  const close = modal("メンバーをキック", others.length ? list : h("p", { class: "muted" }, "ほかにメンバーはいません。"));
}

function openMenu() {
  const v = S.view;
  if (!v) return;
  const me = v.members.find((m) => m.id === v.you);
  const inGame = v.phase === "PLAYING";
  const items: HTMLElement[] = [];
  const item = (label: string, fn: () => void, opts: { danger?: boolean; disabled?: boolean; note?: string } = {}) => {
    const b = h("button", { class: `menu-item${opts.danger ? " danger" : ""}`, type: "button", disabled: opts.disabled }, label, opts.note ? h("small", null, opts.note) : null);
    b.addEventListener("click", () => {
      close();
      fn();
    });
    items.push(b);
  };
  item("招待リンクをコピー", async () => {
    toast((await copyText(inviteUrl())) ? "招待リンクをコピーしました" : "コピーできませんでした", "info");
  });
  item("名前を変える", async () => {
    const n = await promptBox("名前を変える", me?.name ?? "", NAME_MAX);
    if (n !== null && n.trim()) send({ t: "name", name: n.trim() });
  });
  if (v.phase === "LOBBY") item(v.role === "player" ? "観戦に回る" : "参加する", () => send({ t: "role", spectate: v.role === "player" }));
  if (v.role === "spectator" && v.phase !== "LOBBY") item(me?.queued ? "参加予約をやめる" : "次のゲームから参加", () => send({ t: "queue", on: !me?.queued }));
  item("ログを見る", openLog);
  item(`バージョン・更新内容（v${VERSION}）`, openVersion);
  if (isHost() && v.phase !== "LOBBY") item("メンバーをキック", openKick);
  if (isHost() && inGame)
    item(
      "ゲームを中断（END GAME）",
      async () => {
        if (await confirmBox("ゲームを中断してロビーに戻ります。この試合は記録されません。", "中断する", true)) send({ t: "end" });
      },
      { danger: true },
    );
  item(
    "退室する",
    async () => {
      if (await confirmBox("部屋から出ますか？", "退室する", true)) leaveRoom();
    },
    { danger: true, disabled: inGame && seated(), note: inGame && seated() ? "ゲーム中は退室できません" : "" },
  );
  const close = modal("メニュー", h("div", { class: "menu" }, ...items));
}

export function mountRoom(): HTMLElement {
  if (root) return root;
  keyBtn = h("button", { class: "key-chip", type: "button", title: "合言葉（タップで表示）" }) as HTMLButtonElement;
  keyBtn.addEventListener("click", () => {
    showKey = !showKey;
    updateRoom();
  });
  gameNoEl = h("span", { class: "game-no" });
  connEl = h("span", { class: "conn-pill" }, "再接続中…");
  const header = h(
    "header",
    { class: "topbar" },
    h("div", { class: "brand" }, h("b", null, "鉄研"), h("span", null, "UNO")),
    keyBtn,
    gameNoEl,
    connEl,
    h("div", { class: "spacer" }),
    h("button", { class: "icon-btn", type: "button", onclick: openStats }, "成績"),
    h("button", { class: "icon-btn", type: "button", onclick: openMenu, "aria-label": "メニュー" }, "☰"),
  );
  mainEl = h("main", { class: "room-main" });
  root = h("div", { class: "room" }, header, mainEl);
  return root;
}

export function updateRoom() {
  const v = S.view;
  if (!root || !v) return;
  text(keyBtn, showKey ? `合言葉：${v.key}` : "合言葉：••••");
  text(gameNoEl, v.game ? `ゲーム${v.game.no}` : v.games ? `${v.games}試合記録` : "");
  show(connEl, S.conn !== "open");
  const want = v.phase === "LOBBY" ? "lobby" : "board";
  if (want !== mode) {
    mode = want;
    if (want === "lobby") {
      stopBoard();
      replace(mainEl, mountLobby());
    } else replace(mainEl, mountBoard());
  }
  cls(root, "in-game", want === "board");
  if (want === "lobby") updateLobby();
  else updateBoard();
}

export function resetRoom() {
  mode = null;
  stopBoard();
}
