// カードの見た目（画像を使わず CSS と SVG で描く）
import type { Card } from "../shared/cards.js";
import { h } from "./dom.js";

const SVG_NS = "http://www.w3.org/2000/svg";

function svg(viewBox: string, inner: string, cls: string): SVGSVGElement {
  const s = document.createElementNS(SVG_NS, "svg");
  s.setAttribute("viewBox", viewBox);
  s.setAttribute("class", cls);
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = inner;
  return s;
}

function skipIcon(cls: string) {
  return svg(
    "0 0 100 100",
    '<circle cx="50" cy="50" r="34" fill="none" stroke="currentColor" stroke-width="13"/><path d="M26 74 74 26" stroke="currentColor" stroke-width="13" stroke-linecap="round"/>',
    cls,
  );
}

function reverseIcon(cls: string) {
  return svg(
    "0 0 100 100",
    '<path d="M20 42 C22 24 38 16 56 18 L56 6 80 26 56 46 56 33 C44 31 35 35 32 44Z" fill="currentColor"/>' +
      '<path d="M80 58 C78 76 62 84 44 82 L44 94 20 74 44 54 44 67 C56 69 65 65 68 56Z" fill="currentColor"/>',
    cls,
  );
}

function wildOval() {
  return svg(
    "0 0 100 100",
    '<g><path d="M50 50 L50 0 A50 50 0 0 1 100 50Z" fill="#2d7be5"/><path d="M50 50 L100 50 A50 50 0 0 1 50 100Z" fill="#2fa84f"/>' +
      '<path d="M50 50 L50 100 A50 50 0 0 1 0 50Z" fill="#f5c518"/><path d="M50 50 L0 50 A50 50 0 0 1 50 0Z" fill="#e8413c"/></g>',
    "wild-quad",
  );
}

function corner(c: Card): string {
  switch (c.type) {
    case "NUM":
      return String(c.value);
    case "DRAW2":
      return "+2";
    case "WILD4":
      return "+4";
    case "WILD":
      return "W";
    default:
      return "";
  }
}

/**
 * 差分更新（keyed）で使うキー。id だけでなく見た目も含める。
 * 要素を使い回すのは「同じ id で同じ絵」のときだけにして、前のカードの絵が残らないようにする
 */
export function cardKey(c: Card): string {
  return `${c.id}:${c.type}:${c.color ?? "X"}:${c.value ?? ""}`;
}

/** カード1枚の要素 */
export function cardEl(c: Card | null, extra = ""): HTMLElement {
  if (!c) {
    return h(
      "div",
      { class: `card back ${extra}` },
      h("span", { class: "back-emblem" }, h("b", null, "鉄研"), h("i", null, "DOBON")),
    );
  }
  const colorCls = c.color ? `c-${c.color}` : "c-X";
  const el = h("div", { class: `card ${colorCls} t-${c.type} ${extra}`, dataset: { id: c.id } });
  const idx = corner(c);
  const small = (pos: string) => {
    if (c.type === "SKIP") return h("span", { class: `idx ${pos}` }, skipIcon("ico"));
    if (c.type === "REVERSE") return h("span", { class: `idx ${pos}` }, reverseIcon("ico"));
    return h("span", { class: `idx ${pos}` }, idx);
  };
  const oval = h("span", { class: "oval" });
  if (c.type === "WILD" || c.type === "WILD4") oval.appendChild(wildOval());
  let big: Node;
  if (c.type === "SKIP") big = skipIcon("big-ico");
  else if (c.type === "REVERSE") big = reverseIcon("big-ico");
  else if (c.type === "WILD") big = h("span", { class: "big wild-star" }, "★");
  else big = h("span", { class: `big${c.value === 6 || c.value === 9 ? " ul" : ""}` }, idx);
  el.append(small("tl"), oval, h("span", { class: "face" }, big), small("br"));
  return el;
}
