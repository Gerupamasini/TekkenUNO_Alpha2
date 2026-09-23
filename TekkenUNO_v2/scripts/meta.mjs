// ビルドで画面とサーバーに埋め込む情報（バージョン・更新内容）
import { readFileSync } from "node:fs";
import path from "node:path";

/** package.json のバージョンと、CHANGELOG.md の新しいほうから max 個の更新内容 */
export function readMeta(root, max = 5) {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  let text = "";
  try {
    text = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  } catch {
    // CHANGELOG.md がなくてもビルドは通す
  }
  const changes = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const head = line.match(/^##\s+v?(\d+\.\d+\.\d+)\s*(?:[（(]([^）)]*)[）)])?/);
    if (head) {
      if (changes.length >= max) break;
      cur = { v: head[1], date: head[2] ?? "", items: [] };
      changes.push(cur);
      continue;
    }
    const item = line.match(/^[-*]\s+(.+)$/);
    if (item && cur) cur.items.push(item[1].replace(/`/g, ""));
  }
  return { version: String(pkg.version), changes };
}

/** esbuild の define に渡す形 */
export function defines(root, buildId) {
  const { version, changes } = readMeta(root);
  return {
    __BUILD_ID__: JSON.stringify(buildId),
    __APP_VERSION__: JSON.stringify(version),
    __CHANGES__: JSON.stringify(changes),
  };
}
