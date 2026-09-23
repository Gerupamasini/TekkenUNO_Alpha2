// バージョン（ビルドのときに package.json と CHANGELOG.md から埋め込む。scripts/meta.mjs）

declare const __APP_VERSION__: string | undefined;
declare const __BUILD_ID__: string | undefined;
declare const __CHANGES__: { v: string; date: string; items: string[] }[] | undefined;

export const VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
export const BUILD = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";
export const CHANGES = typeof __CHANGES__ === "object" && __CHANGES__ ? __CHANGES__ : [];
