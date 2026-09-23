// 共通の部品：お知らせ、確認、色選び、入力、モーダル
import type { Color } from "../../shared/cards.js";
import { h } from "../dom.js";

let toastBox: HTMLElement | null = null;

export function toast(msg: string, kind: "err" | "info" = "info", ms = 2600) {
  if (!toastBox) {
    toastBox = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
    document.body.appendChild(toastBox);
  }
  const el = h("div", { class: `toast ${kind}` }, msg);
  toastBox.appendChild(el);
  while (toastBox.children.length > 3) toastBox.firstElementChild?.remove();
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 300);
  }, ms);
}

/** モーダルを開く。閉じると close() が呼ばれる */
export function modal(title: string, body: Node, opts: { wide?: boolean; onClose?: () => void } = {}) {
  const close = () => {
    wrap.remove();
    document.removeEventListener("keydown", onKey);
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  const wrap = h(
    "div",
    {
      class: "modal-wrap",
      onclick: (e: Event) => {
        if (e.target === wrap) close();
      },
    },
    h(
      "div",
      { class: `modal${opts.wide ? " wide" : ""}`, role: "dialog", "aria-modal": "true", "aria-label": title },
      h("div", { class: "modal-head" }, h("h2", null, title), h("button", { class: "icon-btn", "aria-label": "閉じる", onclick: close }, "✕")),
      h("div", { class: "modal-body" }, body),
    ),
  );
  document.body.appendChild(wrap);
  document.addEventListener("keydown", onKey);
  return close;
}

export function confirmBox(message: string, ok = "OK", danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      close();
      resolve(v);
    };
    const body = h(
      "div",
      { class: "confirm" },
      h("p", null, message),
      h(
        "div",
        { class: "row end" },
        h("button", { class: "btn ghost", onclick: () => finish(false) }, "やめる"),
        h("button", { class: `btn ${danger ? "danger" : "primary"}`, onclick: () => finish(true) }, ok),
      ),
    );
    const close = modal("確認", body, { onClose: () => finish(false) });
  });
}

export function promptBox(title: string, value: string, maxLength: number): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const input = h("input", { class: "input", value, maxlength: maxLength, autocomplete: "off" }) as HTMLInputElement;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      close();
      resolve(v);
    };
    const form = h(
      "form",
      {
        class: "confirm",
        onsubmit: (e: Event) => {
          e.preventDefault();
          finish(input.value);
        },
      },
      input,
      h("div", { class: "row end" }, h("button", { class: "btn ghost", type: "button", onclick: () => finish(null) }, "やめる"), h("button", { class: "btn primary", type: "submit" }, "決定")),
    );
    const close = modal(title, form, { onClose: () => finish(null) });
    setTimeout(() => input.select(), 30);
  });
}

const COLOR_BTNS: [Color, string][] = [
  ["R", "赤"],
  ["Y", "黄"],
  ["G", "緑"],
  ["B", "青"],
];

export function pickColor(): Promise<Color | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (c: Color | null) => {
      if (done) return;
      done = true;
      close();
      resolve(c);
    };
    const body = h(
      "div",
      { class: "color-pick" },
      ...COLOR_BTNS.map(([c, label]) => h("button", { class: `color-btn c-${c}`, onclick: () => finish(c) }, label)),
    );
    const close = modal("色を選んでください", body, { onClose: () => finish(null) });
  });
}

export async function copyText(s: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(s);
    return true;
  } catch {
    const ta = h("textarea", { style: { position: "fixed", opacity: "0" } }) as HTMLTextAreaElement;
    ta.value = s;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand?.("copy") ?? false;
    ta.remove();
    return ok;
  }
}
