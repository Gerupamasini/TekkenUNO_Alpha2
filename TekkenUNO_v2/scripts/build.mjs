// 本番用ビルド：画面（dist/client）とサーバー（dist/server.js）を作る
import { build } from "esbuild";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FAVICON } from "./favicon.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "dist");
const buildId =
  (process.env.RENDER_GIT_COMMIT || "").slice(0, 8) || new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
const define = { __BUILD_ID__: JSON.stringify(buildId) };


rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, "client"), { recursive: true });

const client = await build({
  entryPoints: { app: path.join(root, "src/client/main.ts") },
  bundle: true,
  minify: true,
  format: "iife",
  target: ["es2020", "safari15", "chrome96", "firefox95"],
  outdir: path.join(out, "client/assets"),
  entryNames: "[name]-[hash]",
  metafile: true,
  define,
  legalComments: "none",
  logLevel: "warning",
});
const files = Object.keys(client.metafile.outputs);
const js = path.basename(files.find((f) => f.endsWith(".js")));
const css = path.basename(files.find((f) => f.endsWith(".css")));
const html = readFileSync(path.join(root, "src/client/index.html"), "utf8").replace("%JS%", `/assets/${js}`).replace("%CSS%", `/assets/${css}`);
writeFileSync(path.join(out, "client/index.html"), html);
writeFileSync(path.join(out, "client/favicon.svg"), FAVICON);

await build({
  entryPoints: [path.join(root, "src/server/index.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: path.join(out, "server.js"),
  define,
  logLevel: "warning",
});

const size = (f) => `${(Object.values(client.metafile.outputs).find((o, i) => files[i].endsWith(f))?.bytes / 1024).toFixed(1)}KB`;
console.log(`build ${buildId}: client ${js} (${size(".js")}), ${css} (${size(".css")}) / server dist/server.js`);
