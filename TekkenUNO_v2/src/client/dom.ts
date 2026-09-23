// DOM を組み立てる小さな道具（フレームワークなしで軽く動かすため）

type Child = Node | string | number | null | undefined | false;
type Props = Record<string, unknown> | null | undefined;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = String(v);
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k === "dataset" && typeof v === "object") Object.assign(el.dataset, v);
      else if (k.startsWith("on") && typeof v === "function") {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === "html") el.innerHTML = String(v);
      else if (v === true) el.setAttribute(k, "");
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
  }
}

/** 子要素を入れ替える */
export function replace(el: Element, ...children: Child[]) {
  el.replaceChildren();
  append(el, children);
}

export function text(el: Element, s: string) {
  if (el.textContent !== s) el.textContent = s;
}

export function cls(el: Element, name: string, on: boolean) {
  if (el.classList.contains(name) !== on) el.classList.toggle(name, on);
}

export function show(el: HTMLElement, on: boolean) {
  if (el.hidden === on) el.hidden = !on;
}

/**
 * キー付きの一覧を差分で更新する。既存の要素は使い回すので、アニメーションが途切れない
 */
export function keyed<T>(
  parent: HTMLElement,
  items: readonly T[],
  key: (t: T) => string,
  create: (t: T) => HTMLElement,
  update?: (el: HTMLElement, t: T, index: number) => void,
) {
  const old = new Map<string, HTMLElement>();
  for (const ch of Array.from(parent.children) as HTMLElement[]) {
    const k = ch.dataset.key;
    if (k !== undefined) old.set(k, ch);
  }
  let ref: ChildNode | null = parent.firstChild;
  items.forEach((it, i) => {
    const k = key(it);
    let el = old.get(k);
    if (el) old.delete(k);
    else {
      el = create(it);
      el.dataset.key = k;
    }
    update?.(el, it, i);
    if (el !== ref) parent.insertBefore(el, ref);
    else ref = ref.nextSibling;
    ref = el.nextSibling;
  });
  for (const el of old.values()) el.remove();
}

export function rectOf(el: Element | null): DOMRect | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width || r.height ? r : null;
}
