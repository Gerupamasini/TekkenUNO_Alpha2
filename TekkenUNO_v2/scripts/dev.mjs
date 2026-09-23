// 開発用：画面を監視ビルドし、サーバーを変更のたびに再起動する
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { context } from "esbuild";
import { defines } from "./meta.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "dist/client");
mkdirSync(path.join(out, "assets"), { recursive: true });
const html = readFileSync(path.join(root, "src/client/index.html"), "utf8").replace("%JS%", "/assets/app.js").replace("%CSS%", "/assets/app.css");
writeFileSync(path.join(out, "index.html"), html);
const { FAVICON } = await import("./favicon.mjs");
writeFileSync(path.join(out, "favicon.svg"), FAVICON);

const ctx = await context({
  entryPoints: { app: path.join(root, "src/client/main.ts") },
  bundle: true,
  sourcemap: true,
  format: "iife",
  outdir: path.join(out, "assets"),
  entryNames: "[name]",
  define: defines(root, "dev"),
  logLevel: "info",
});
await ctx.watch();

const port = process.env.PORT ?? "10000";
spawn(process.execPath, ["--import", "tsx", "--watch", "src/server/index.ts"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, PORT: port },
});
console.log(`開発サーバー: http://localhost:${port}/`);
