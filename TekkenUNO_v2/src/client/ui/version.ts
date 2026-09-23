// バージョンの表示と「更新内容」
import { h } from "../dom.js";
import { BUILD, CHANGES, VERSION } from "../version.js";
import { modal } from "./common.js";

export function openVersion() {
  const body = h(
    "div",
    { class: "version-info" },
    h("p", { class: "version-line" }, h("b", null, `鉄研UNO Online v${VERSION}`), h("small", null, ` ビルド ${BUILD}`)),
    ...CHANGES.map((c) =>
      h(
        "section",
        { class: "change" },
        h("h3", null, `v${c.v}`, c.date ? h("small", null, `（${c.date}）`) : null),
        h("ul", null, ...c.items.map((it) => h("li", null, it))),
      ),
    ),
  );
  modal("バージョン・更新内容", body, { wide: true });
}

/** 画面の下などに置く「v2.2.0 ・ 更新内容」 */
export function versionFoot(): HTMLElement {
  return h(
    "p",
    { class: "version-foot" },
    h("span", { class: "version-no" }, `v${VERSION}`),
    h("button", { class: "link-btn", type: "button", onclick: openVersion }, "更新内容"),
  );
}
