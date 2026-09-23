// 演出（カードの移動、カットイン帯、ドボンの大演出など）。transform と opacity だけを動かして軽くする
import type { Card } from "../shared/cards.js";
import { cardEl } from "./cardview.js";
import { h } from "./dom.js";

const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

let layerEl: HTMLElement | null = null;
function layer(): HTMLElement {
  if (!layerEl) {
    layerEl = h("div", { id: "fx", "aria-hidden": "true" });
    document.body.appendChild(layerEl);
  }
  return layerEl;
}

function place(el: HTMLElement, r: { left: number; top: number; width: number; height: number }) {
  el.style.left = `${r.left}px`;
  el.style.top = `${r.top}px`;
  el.style.width = `${r.width}px`;
  el.style.height = `${r.height}px`;
  el.style.setProperty("--cw", `${r.width}px`);
}

export interface FlyOpts {
  delay?: number;
  duration?: number;
  rotate?: number;
  /** 到着時の大きさ（出発時を1とした比） */
  endScale?: number;
  fadeOut?: boolean;
}

/** from の位置から to の位置へ要素を飛ばす */
export function fly(from: DOMRect, to: DOMRect, el: HTMLElement, o: FlyOpts = {}): Promise<void> {
  const L = layer();
  el.classList.add("flying");
  place(el, from);
  L.appendChild(el);
  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  const s = o.endScale ?? to.width / Math.max(1, from.width);
  const rot = o.rotate ?? 0;
  const anim = el.animate(
    [
      { transform: "translate(0,0) scale(1) rotate(0deg)", opacity: 1 },
      { transform: `translate(${dx * 0.55}px, ${dy * 0.55 - 30}px) scale(${(1 + s) / 2 + 0.08}) rotate(${rot / 2}deg)`, opacity: 1, offset: 0.55 },
      { transform: `translate(${dx}px, ${dy}px) scale(${s}) rotate(${rot}deg)`, opacity: o.fadeOut ? 0 : 1 },
    ],
    { duration: reduce ? 1 : (o.duration ?? 380), delay: o.delay ?? 0, easing: "cubic-bezier(.2,.7,.2,1)", fill: "forwards" },
  );
  return anim.finished.then(
    () => el.remove(),
    () => el.remove(),
  );
}

/** カード（表 or 裏）を何枚か飛ばす */
export function flyCards(from: DOMRect, to: DOMRect, cards: (Card | null)[], o: FlyOpts & { stagger?: number; spread?: number } = {}) {
  const n = Math.min(cards.length, 12);
  const w = Math.min(from.width, 90) || 60;
  const hgt = w * 1.43;
  const src = new DOMRect(from.left + from.width / 2 - w / 2, from.top + from.height / 2 - hgt / 2, w, hgt);
  const tw = Math.min(to.width, 110) || w;
  const dst = new DOMRect(to.left + to.width / 2 - tw / 2, to.top + to.height / 2 - (tw * 1.43) / 2, tw, tw * 1.43);
  const ps: Promise<void>[] = [];
  for (let i = 0; i < n; i++) {
    const el = cardEl(cards[i]);
    const spread = (o.spread ?? 16) * (i - (n - 1) / 2);
    const d = new DOMRect(dst.left + spread, dst.top, dst.width, dst.height);
    ps.push(fly(src, d, el, { ...o, delay: (o.delay ?? 0) + i * (o.stagger ?? 60), rotate: (o.rotate ?? 0) + (i - (n - 1) / 2) * 6 }));
  }
  return Promise.all(ps);
}

/** 画面中央の大きな文字 */
export function banner(text: string, kind: string, sub = "", ms = 1300) {
  const el = h("div", { class: `banner b-${kind}` }, h("div", { class: "banner-band" }), h("div", { class: "banner-text", "data-text": text }, text), sub ? h("div", { class: "banner-sub" }, sub) : null);
  layer().appendChild(el);
  setTimeout(() => el.remove(), reduce ? 900 : ms);
}

/** 席や手札の上に出る吹き出し */
export function bubble(at: DOMRect | null, text: string, kind: string, ms = 1600) {
  if (!at) return;
  const el = h("div", { class: `bubble k-${kind}` }, text);
  el.style.left = `${at.left + at.width / 2}px`;
  el.style.top = `${at.top}px`;
  layer().appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/** 画面全体の光 */
export function flash(kind: string) {
  if (reduce) return;
  const el = h("div", { class: `flash f-${kind}` });
  layer().appendChild(el);
  setTimeout(() => el.remove(), 700);
}

export function shake(strong = false) {
  if (reduce) return;
  const app = document.getElementById("app");
  if (!app) return;
  app.classList.remove("shake", "shake-strong");
  void app.offsetWidth;
  app.classList.add(strong ? "shake-strong" : "shake");
  setTimeout(() => app.classList.remove("shake", "shake-strong"), 600);
}

const CONFETTI = ["#ffd400", "#ff4d6d", "#39d98a", "#3fa9ff", "#ffffff", "#ff9f1c", "#c77dff"];

export function confetti(count = 40, origin?: DOMRect) {
  if (reduce) return;
  const L = layer();
  const W = window.innerWidth;
  const H = window.innerHeight;
  const ox = origin ? origin.left + origin.width / 2 : W / 2;
  const oy = origin ? origin.top + origin.height / 2 : H * 0.4;
  for (let i = 0; i < count; i++) {
    const el = h("i", { class: "confetti" });
    el.style.background = CONFETTI[i % CONFETTI.length];
    el.style.left = `${ox}px`;
    el.style.top = `${oy}px`;
    L.appendChild(el);
    const ang = Math.random() * Math.PI * 2;
    const dist = 120 + Math.random() * Math.max(W, H) * 0.45;
    const dx = Math.cos(ang) * dist;
    const dy = Math.sin(ang) * dist * 0.7 - 80;
    const rot = (Math.random() - 0.5) * 900;
    el.animate(
      [
        { transform: "translate(0,0) rotate(0deg)", opacity: 1 },
        { transform: `translate(${dx}px, ${dy}px) rotate(${rot / 2}deg)`, opacity: 1, offset: 0.6 },
        { transform: `translate(${dx * 1.1}px, ${dy + 260}px) rotate(${rot}deg)`, opacity: 0 },
      ],
      { duration: 1300 + Math.random() * 700, easing: "cubic-bezier(.1,.8,.3,1)", fill: "forwards" },
    ).finished.then(
      () => el.remove(),
      () => el.remove(),
    );
  }
}

/** 数字を 0 から数え上げる */
export function countUp(el: HTMLElement, to: number, ms = 700, delay = 0) {
  if (reduce || to === 0) {
    el.textContent = String(to);
    return;
  }
  const start = performance.now() + delay;
  el.textContent = "0";
  const step = (t: number) => {
    const p = Math.min(1, Math.max(0, (t - start) / ms));
    const e = 1 - Math.pow(1 - p, 3);
    el.textContent = String(Math.round(to * e));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** 要素に一度だけアニメーション用のクラスを付ける */
export function pop(el: Element | null, cls = "pop") {
  if (!el) return;
  el.classList.remove(cls);
  void (el as HTMLElement).offsetWidth;
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), 700);
}
