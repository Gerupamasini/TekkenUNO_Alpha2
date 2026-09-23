// 入室画面：名前と合言葉を入れて部屋に入る（ゴッドフィールドの隠れ乱闘方式）
import { KEY_MAX, NAME_MAX } from "../../shared/protocol.js";
import { h, show, text } from "../dom.js";
import { join, savedName } from "../net.js";
import { S } from "../store.js";
import { toast } from "./common.js";

let root: HTMLElement | null = null;
let statusEl: HTMLElement;
let nameIn: HTMLInputElement;
let keyIn: HTMLInputElement;
let joinBtn: HTMLButtonElement;
let watchBtn: HTMLButtonElement;
let noticeEl: HTMLElement;

function keyFromHash(): string {
  try {
    return decodeURIComponent(location.hash.replace(/^#/, ""));
  } catch {
    return "";
  }
}

function submit(spectate: boolean) {
  const name = nameIn.value.trim();
  const key = keyIn.value.trim();
  if (!name) {
    toast("名前を入れてください", "err");
    nameIn.focus();
    return;
  }
  if (!key) {
    toast("合言葉を入れてください", "err");
    keyIn.focus();
    return;
  }
  S.notice = "";
  join({ key, name, spectate });
}

export function mountEntry(): HTMLElement {
  if (root) return root;
  nameIn = h("input", { class: "input", id: "name", maxlength: NAME_MAX, placeholder: "例：ぎぱ", autocomplete: "nickname", enterkeyhint: "next" }) as HTMLInputElement;
  keyIn = h("input", { class: "input", id: "key", maxlength: KEY_MAX, placeholder: "例：てつけん", autocomplete: "off", enterkeyhint: "go" }) as HTMLInputElement;
  nameIn.value = savedName();
  keyIn.value = keyFromHash();
  joinBtn = h("button", { class: "btn primary big", type: "submit" }, "入室する") as HTMLButtonElement;
  watchBtn = h("button", { class: "btn ghost", type: "button", onclick: () => submit(true) }, "観戦で入る") as HTMLButtonElement;
  statusEl = h("div", { class: "conn-status" });
  noticeEl = h("div", { class: "notice" });
  root = h(
    "section",
    { class: "entry" },
    h(
      "div",
      { class: "entry-card" },
      h("div", { class: "logo" }, h("span", { class: "logo-a" }, "鉄研"), h("span", { class: "logo-b" }, "UNO"), h("span", { class: "logo-c" }, "ONLINE")),
      h("p", { class: "tagline" }, "上がれるのはドボンだけ。"),
      noticeEl,
      h(
        "form",
        {
          class: "entry-form",
          onsubmit: (e: Event) => {
            e.preventDefault();
            submit(false);
          },
        },
        h("label", { for: "name" }, "名前"),
        nameIn,
        h("label", { for: "key" }, "合言葉"),
        keyIn,
        h("p", { class: "help" }, "同じ合言葉を入れた人どうしが同じ部屋に入ります。部屋がなければ作られます。"),
        h("div", { class: "row" }, joinBtn, watchBtn),
      ),
      statusEl,
    ),
  );
  return root;
}

export function updateEntry() {
  if (!root) return;
  const connecting = S.conn !== "open";
  joinBtn.disabled = connecting;
  watchBtn.disabled = connecting;
  if (S.conn === "open") text(statusEl, "● サーバーに接続しました");
  else if (S.slow) text(statusEl, "サーバーを起動しています…（しばらく使われていないと最大1分ほどかかります）");
  else text(statusEl, "接続中…");
  statusEl.className = `conn-status ${S.conn}`;
  text(noticeEl, S.notice);
  show(noticeEl, !!S.notice);
}
